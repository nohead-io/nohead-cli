import { join } from "node:path"

import type { Command } from "commander"

import type {
  Asset,
  NoheadDraft,
  NoheadRecord as RecordModel,
  RecordData,
  RecordRevisionDetail,
} from "@nohead/sdk"
import type { CommandContext } from "../context.ts"
import {
  CliError,
  ExitCode,
  isForbidden,
  itemError,
  unwrap,
  type ErrorBody,
} from "../errors.ts"
import { isObject, parseJsonObject, readSource } from "../input.ts"
import {
  count,
  printNotice,
  printResult,
  toJson,
  toJsonLines,
} from "../output.ts"
import {
  fromCollections,
  fromYaml,
  toYaml,
  type CollectionSpec,
} from "../schema/format.ts"
import { applicable, describeChange, planChanges } from "../schema/plan.ts"
import { downloadFile, uploadAsset } from "./assets.ts"
import { allRecords } from "./records.ts"
import { applyPlan, remoteCollections } from "./schema.ts"

/**
 * A project export: portable, documented files.
 *
 *   manifest.json            what was exported, from where, when
 *   schema.yaml              the schema, as `nohead schema pull` writes it
 *   records/<slug>.jsonl     one API record per line
 *   drafts/<slug>.jsonl      one API draft per line (changes waiting to merge)
 *   history/<slug>.jsonl     with --include-history: each record's revisions
 *   assets.jsonl             one API asset per line (metadata)
 *   assets/<asset id>        with --include-files: the original files
 */
export interface Manifest {
  format: "nohead-export"
  version: 1
  exported_at: string
  api_url: string
  project_id: string
  include_history: boolean
  include_deleted: boolean
  include_files?: boolean
  assets?: number
  /** `drafts` is left out by exports from before drafts. */
  collections: { slug: string; records: number; drafts?: number }[]
}

const ASSET_ID = /^ast_[0-9A-Z]{26}$/
// The API's slug format (Sluggable): safe as a file name.
const SLUG = /^[a-z][a-z0-9_-]{0,62}$/

/**
 * Export paths are built from collection slugs and asset IDs, which come
 * from the API: one like "../../.zshrc" must not write outside the export.
 */
function safeName(pattern: RegExp, value: string, what: string): string {
  if (!pattern.test(value))
    throw new CliError(ExitCode.ApiError, {
      type: "unexpected_response",
      message: `The API returned ${what} ${toJson(value)}, which is not safe as a file name; nothing more was written`,
    })
  return value
}

/**
 * A renamed field's old keys repeat its value for a while (aliases, listed
 * on the field); the export keeps only the current keys.
 */
function withoutAliases<T extends { data: RecordData }>(
  item: T,
  aliases: Set<string>
): T {
  if (aliases.size === 0) return item
  return {
    ...item,
    data: Object.fromEntries(
      Object.entries(item.data).filter(([key]) => !aliases.has(key))
    ),
  }
}

/** The project's assets that have a file: uploads completed. */
async function allAssets(
  ctx: CommandContext
): Promise<(Asset & { file_url: string })[]> {
  const all = await unwrap(
    Array.fromAsync((await ctx.project()).assets.list({ limit: 100 }))
  )
  return all.filter(
    (asset): asset is Asset & { file_url: string } => asset.file_url !== null
  )
}

/**
 * The exported files' metadata (with --include-files). An ID names a file in
 * the export, so anything but an asset ID could reach outside it
 * ("../../.ssh/id_ed25519").
 */
async function readExportedAssets(
  ctx: CommandContext,
  dir: string,
  manifest: Manifest,
  problems: string[]
): Promise<Asset[]> {
  if (!manifest.include_files) return []
  const file = "assets.jsonl"
  let text: string
  try {
    text = await readSource(ctx.runtime, join(dir, file))
  } catch {
    problems.push(`${file} is missing`)
    return []
  }
  return readLines<Asset>(
    text,
    file,
    "an asset (its id is not an asset ID)",
    (item) => typeof item.id === "string" && ASSET_ID.test(item.id),
    problems
  )
}

/** Re-uploads exported files; old asset ID -> new. */
async function importAssets(
  ctx: CommandContext,
  dir: string,
  manifest: Manifest,
  assets: Asset[]
) {
  const ids = new Map<string, string>()
  if (assets.length === 0) return ids

  for (const asset of assets) {
    const bytes = await ctx.runtime.readBinaryFile(
      join(dir, "assets", asset.id)
    )
    const key = `import-${manifest.project_id}-${asset.id}`
    // With its alt text in the same call (exports from before assets had
    // alt text have none).
    const copy = await uploadAsset(
      ctx,
      {
        bytes,
        filename: asset.filename,
        contentType: asset.content_type,
        alt: asset.alt,
      },
      key
    )
    ids.set(asset.id, copy.id)
  }
  if (ids.size > 0) printNotice(ctx, `Imported ${count(ids.size, "file")}`)
  return ids
}

async function history(
  ctx: CommandContext,
  record: RecordModel
): Promise<RecordRevisionDetail[]> {
  const revisions: RecordRevisionDetail[] = []
  for (const { revision } of await unwrap(
    Array.fromAsync(ctx.api.records.revisions.list(record.id, { limit: 100 }))
  )) {
    revisions.push(
      await unwrap(ctx.api.records.revisions.get(record.id, revision))
    )
  }
  return revisions.reverse()
}

export function registerPortability(
  program: Command,
  context: () => CommandContext
) {
  program
    .command("export")
    .description("Export the project's schema and records to a directory")
    .requiredOption("--output <dir>", "directory to write (created if needed)")
    .option("--include-history", "also export every record's revisions", false)
    .option("--include-deleted", "also export deleted records", false)
    .option(
      "--include-files",
      "also download every asset's original file",
      false
    )
    .action(
      async (options: {
        output: string
        includeHistory: boolean
        includeDeleted: boolean
        includeFiles: boolean
      }) => {
        const ctx = context()
        const remote = await remoteCollections(ctx)
        await ctx.runtime.writeFile(
          join(options.output, "schema.yaml"),
          toYaml(fromCollections(remote))
        )

        const counts: Manifest["collections"] = []
        // Published-only keys can't read drafts; their export goes without.
        let draftsReadable = true
        for (const collection of remote) {
          const records = await allRecords(ctx, collection.id, { limit: 100 })
          if (options.includeDeleted)
            records.push(
              ...(await allRecords(ctx, collection.id, {
                limit: 100,
                filter: { deleted: true },
              }))
            )
          const aliases = new Set(
            collection.fields.flatMap((f) => f.aliases.map((a) => a.key))
          )
          const file = `${safeName(SLUG, collection.slug, "a collection slug")}.jsonl`
          await ctx.runtime.writeFile(
            join(options.output, "records", file),
            toJsonLines(
              records.map((record) => withoutAliases(record, aliases))
            )
          )
          if (options.includeHistory) {
            const revisions = []
            for (const record of records)
              revisions.push({
                record_id: record.id,
                revisions: await history(ctx, record),
              })
            await ctx.runtime.writeFile(
              join(options.output, "history", file),
              toJsonLines(revisions)
            )
          }
          // A deleted record's draft is hidden with it, so isn't exported.
          let drafts: NoheadDraft[] | undefined
          if (draftsReadable) {
            try {
              drafts = await unwrap(
                Array.fromAsync(
                  ctx.api.drafts.list(collection.id, { limit: 100 })
                )
              )
            } catch (error) {
              if (!isForbidden(error)) throw error
              draftsReadable = false
              printNotice(ctx, `Skipped drafts: ${error.body.message}`)
            }
          }
          if (drafts)
            await ctx.runtime.writeFile(
              join(options.output, "drafts", file),
              toJsonLines(drafts.map((draft) => withoutAliases(draft, aliases)))
            )
          counts.push({
            slug: collection.slug,
            records: records.length,
            ...(drafts && { drafts: drafts.length }),
          })
          printNotice(
            ctx,
            `Exported ${count(records.length, `${collection.slug} record`)}${drafts ? ` and ${count(drafts.length, "draft")}` : ""}`
          )
        }

        // Keys without assets:read still export schema and records.
        let assets: Awaited<ReturnType<typeof allAssets>> = []
        try {
          assets = await allAssets(ctx)
        } catch (error) {
          if (!isForbidden(error) || options.includeFiles) throw error
          printNotice(ctx, `Skipped assets: ${error.body.message}`)
        }
        await ctx.runtime.writeFile(
          join(options.output, "assets.jsonl"),
          toJsonLines(assets)
        )
        if (options.includeFiles) {
          for (const asset of assets) {
            const path = join(
              options.output,
              "assets",
              safeName(ASSET_ID, asset.id, "an asset ID")
            )
            await ctx.runtime.writeFile(
              path,
              await downloadFile(
                ctx,
                asset.file_url,
                asset.byte_size,
                asset.filename
              )
            )
          }
          printNotice(ctx, `Exported ${count(assets.length, "file")}`)
        }

        const manifest: Manifest = {
          format: "nohead-export",
          version: 1,
          exported_at: ctx.runtime.now().toISOString(),
          api_url: ctx.baseUrl,
          project_id: await ctx.projectId(),
          include_history: options.includeHistory,
          include_deleted: options.includeDeleted,
          include_files: options.includeFiles,
          assets: assets.length,
          collections: counts,
        }
        await ctx.runtime.writeFile(
          join(options.output, "manifest.json"),
          `${toJson(manifest, 2)}\n`
        )
        printResult(
          ctx,
          manifest,
          () =>
            `Exported ${count(counts.length, "collection")} to ${options.output}`
        )
      }
    )

  program
    .command("import")
    .description(
      "Import an export into the project: schema first, then records (re-runnable for 24 hours)"
    )
    .argument("<dir>", "a directory written by nohead export")
    .action(async (dir: string) => {
      const ctx = context()
      const manifest = parseJsonObject(
        await readSource(ctx.runtime, join(dir, "manifest.json")),
        "manifest.json"
      ) as unknown as Manifest
      if (manifest.format !== "nohead-export" || manifest.version !== 1)
        throw new CliError(ExitCode.Usage, {
          type: "invalid_request",
          message: `${dir} is not a nohead export (version 1)`,
        })

      // Schema: the same planner as schema push, without field migrations.
      const schemaFile = join(dir, "schema.yaml")
      const desired = fromYaml(
        await readSource(ctx.runtime, schemaFile),
        schemaFile
      )
      // Everything is read and checked before anything is written, so a
      // broken file never leaves a half-imported project.
      const { exported, assets } = await readExport(ctx, dir, manifest, desired)
      const remote = await remoteCollections(ctx)
      const changes = applicable(
        planChanges(desired, fromCollections(remote), remote)
      )
      if (changes.some((c) => c.kind === "migrate_field")) {
        throw new CliError(ExitCode.Usage, {
          type: "invalid_request",
          message: `The project has fields of another type than the export, so import into an empty project or migrate them first: ${changes
            .filter((c) => c.kind === "migrate_field")
            .map(describeChange)
            .join("; ")}`,
        })
      }
      for (const change of changes) printNotice(ctx, describeChange(change))
      const { ids } = await applyPlan(ctx, remote, changes, {
        clearInvalid: false,
      })

      const assetIds = await importAssets(ctx, dir, manifest, assets)
      const result = await importContent(
        ctx,
        manifest,
        exported,
        desired,
        ids,
        assetIds
      )
      printResult(ctx, result, () =>
        [
          `Imported ${count(result.created, "record")} into ${count(result.collections, "collection")} (${result.relinked} with relations, ${result.published} published), ${count(result.drafts, "draft")} and ${count(assetIds.size, "file")}.`,
          ...(result.droppedAssets > 0
            ? [
                `  ${result.droppedAssets} asset value(s) were left out: export with --include-files to bring the files along.`,
              ]
            : []),
          ...result.failed.map(
            (f) =>
              `  ${f.collection} ${f.record}: ${f.error.message}${(
                f.error.details ?? []
              )
                .map((d) => `; ${d.field ? `${d.field}: ` : ""}${d.message}`)
                .join("")}`
          ),
        ].join("\n")
      )
      if (result.failed.length > 0)
        throw new CliError(ExitCode.ApiError, {
          type: "validation_error",
          message: `${result.failed.length} record(s) or draft(s) failed to import`,
        })
    })
}

/** A collection's exported records and drafts, by slug. */
type ExportedContent = Map<
  string,
  { records: RecordModel[]; drafts: NoheadDraft[] }
>

/**
 * The objects of a JSON Lines file that pass `valid`; the others, and lines
 * that aren't JSON, become problems.
 */
function readLines<T>(
  text: string,
  file: string,
  what: string,
  valid: (item: Record<string, unknown>) => boolean,
  problems: string[]
): T[] {
  const items: T[] = []
  text.split("\n").forEach((line, index) => {
    if (!line.trim()) return
    try {
      const item = parseJsonObject(line, `${file} line ${index + 1}`)
      if (valid(item)) items.push(item as unknown as T)
      else problems.push(`${file} line ${index + 1} is not ${what}`)
    } catch (error) {
      problems.push(
        error instanceof CliError
          ? error.body.message
          : `${file} line ${index + 1} is not JSON`
      )
    }
  })
  return items
}

/**
 * Reads every exported record, draft and file's metadata and checks the
 * export is complete and consistent: each collection is in the schema, each
 * file parses, each line is a record (an ID and data), a draft (also its
 * record and changed fields) or an asset (an asset ID), and the counts match
 * the manifest.
 */
async function readExport(
  ctx: CommandContext,
  dir: string,
  manifest: Manifest,
  schema: CollectionSpec[]
): Promise<{ exported: ExportedContent; assets: Asset[] }> {
  const problems: string[] = []
  const exported: ExportedContent = new Map()
  for (const {
    slug,
    records: expected,
    drafts: expectedDrafts,
  } of manifest.collections) {
    if (!SLUG.test(slug)) {
      problems.push(`${toJson(slug)} in manifest.json is not a collection slug`)
      continue
    }
    if (!schema.some((c) => c.slug === slug)) {
      problems.push(`${slug} is in manifest.json but not in schema.yaml`)
      continue
    }
    const file = `records/${slug}.jsonl`
    let text: string
    try {
      text = await readSource(ctx.runtime, join(dir, file))
    } catch {
      problems.push(`${file} is missing`)
      continue
    }
    const records = readLines<RecordModel>(
      text,
      file,
      "a record (no id or data)",
      (item) => typeof item.id === "string" && isObject(item.data),
      problems
    )
    if (records.length !== expected)
      problems.push(
        `${file} has ${records.length} records; manifest.json says ${expected}`
      )

    let drafts: NoheadDraft[] = []
    if (expectedDrafts !== undefined) {
      const draftFile = `drafts/${slug}.jsonl`
      let draftText: string | undefined
      try {
        draftText = await readSource(ctx.runtime, join(dir, draftFile))
      } catch {
        problems.push(`${draftFile} is missing`)
      }
      if (draftText !== undefined) {
        drafts = readLines<NoheadDraft>(
          draftText,
          draftFile,
          "a draft (no id, record_id, data or changed_fields)",
          (item) =>
            typeof item.id === "string" &&
            typeof item.record_id === "string" &&
            isObject(item.data) &&
            Array.isArray(item.changed_fields),
          problems
        )
        if (drafts.length !== expectedDrafts)
          problems.push(
            `${draftFile} has ${drafts.length} drafts; manifest.json says ${expectedDrafts}`
          )
        const ids = new Set(records.map((record) => record.id))
        for (const draft of drafts)
          if (!ids.has(draft.record_id))
            problems.push(
              `${draftFile}: ${draft.id} is for ${draft.record_id}, which is not in ${file}`
            )
      }
    }
    exported.set(slug, { records, drafts })
  }
  const assets = await readExportedAssets(ctx, dir, manifest, problems)
  if (problems.length > 0)
    throw new CliError(ExitCode.Usage, {
      type: "invalid_request",
      message: `The export in ${dir} is incomplete or damaged; nothing was imported`,
      details: problems
        .slice(0, 20)
        .map((message) => ({ code: "invalid_export", message })),
    })
  return { exported, assets }
}

/** A collection's fields by what import does to their values. */
interface FieldKinds {
  relations: string[]
  assets: string[]
  richText: string[]
}

function fieldKinds(spec: CollectionSpec): FieldKinds {
  const of = (type: string) =>
    spec.fields.filter((f) => f.type === type).map((f) => f.key)
  return {
    relations: of("relation"),
    assets: of("asset"),
    richText: of("rich_text"),
  }
}

/**
 * Exported values as the importing project's: asset IDs become the imported
 * copies' and relation IDs the created records' (targets that were not
 * imported are dropped). Without `records`, relation values are left out,
 * to be set once every record exists. `dropped` counts asset values left out.
 */
function importedValues(
  data: RecordData,
  kinds: FieldKinds,
  assetIds: Map<string, string>,
  records?: Map<string, string>
): { data: RecordData; dropped: number } {
  let dropped = 0
  const values = Object.entries(data).flatMap(
    ([field, value]): [string, unknown][] => {
      if (kinds.relations.includes(field)) {
        if (!records) return []
        const map = (id: unknown) => records.get(String(id))
        return [
          [
            field,
            Array.isArray(value)
              ? value.map(map).filter(Boolean)
              : (map(value) ?? null),
          ],
        ]
      }
      const map = (id: unknown) => assetIds.get(String(id))
      if (kinds.richText.includes(field)) {
        const { document, dropped: images } = remapImages(value, map)
        dropped += images
        return [[field, document]]
      }
      if (!kinds.assets.includes(field)) return [[field, value]]
      if (Array.isArray(value)) {
        const mapped = value.map(map).filter(Boolean)
        dropped += value.length - mapped.length
        return [[field, mapped]]
      }
      const mapped = map(value)
      if (mapped === undefined) {
        // null stays null; only a value whose file wasn't imported is dropped.
        if (value !== null && value !== undefined) dropped += 1
        return value === null ? [[field, null]] : []
      }
      return [[field, mapped]]
    }
  )
  return { data: Object.fromEntries(values), dropped }
}

/**
 * The collections in the order to create their records: each after the
 * collections its relations point at, so a required relation can be set when
 * its record is created. Otherwise the export's order stays; a
 * self-reference, or one link in a cycle, waits for the relations pass.
 */
export function creationOrder(
  slugs: string[],
  schema: CollectionSpec[]
): string[] {
  const targets = (slug: string) =>
    (schema.find((c) => c.slug === slug)?.fields ?? [])
      .filter((field) => field.type === "relation")
      .map((field) => String(field.options.collection))
      .filter((target) => target !== slug && slugs.includes(target))
  const ordered: string[] = []
  const visiting = new Set<string>()
  const visit = (slug: string) => {
    if (ordered.includes(slug) || visiting.has(slug)) return
    visiting.add(slug)
    targets(slug).forEach(visit)
    visiting.delete(slug)
    ordered.push(slug)
  }
  slugs.forEach(visit)
  return ordered
}

/**
 * A record's relation values split by when they can be set: `now`, mapped to
 * the created records, when every target is created already (or the value is
 * empty), and `later`, the fields with a target still to come, set by the
 * relations pass. Targets that weren't exported are left out, as they are
 * then.
 */
export function relationsAtCreate(
  data: RecordData,
  kinds: FieldKinds,
  created: Map<string, string>,
  exported: Set<string>
): { now: RecordData; later: string[] } {
  const now: RecordData = {}
  const later: string[] = []
  for (const field of kinds.relations) {
    const value = data[field]
    if (value === undefined) continue
    const ids = (Array.isArray(value) ? value : [value]).filter(
      (id) => id != null
    )
    if (ids.some((id) => exported.has(String(id)) && !created.has(String(id))))
      later.push(field)
    else
      Object.assign(
        now,
        importedValues({ [field]: value }, kinds, new Map(), created).data
      )
  }
  return { now, later }
}

/**
 * Whether an exported record can be created published: live, not deleted,
 * and with no relation values to set afterwards (which would change it
 * while live).
 */
export function publishesOnCreate(
  record: RecordModel,
  later: string[]
): boolean {
  return !!record.published_at && !record.deleted_at && later.length === 0
}

/**
 * Records in three passes. Collections go in creationOrder, and each record
 * is created with the relation values whose targets exist already (so
 * required relations work); then the relations that point at records created
 * later are set with the new IDs; then records are published and deleted as
 * exported. A published record with no relations left to set, and not
 * deleted, is created published in one request.
 * Drafts come last, on the created records: each starts from the fields it
 * changes, so its `base_revision` is the imported record's, and a merge still
 * to come is scheduled again. Every request carries an Idempotency-Key
 * derived from what was exported, so re-running an interrupted import within
 * 24 hours skips what was done.
 */
async function importContent(
  ctx: CommandContext,
  manifest: Manifest,
  exported: ExportedContent,
  schema: CollectionSpec[],
  collectionIds: Map<string, string>,
  assetIds: Map<string, string>
) {
  const key = (item: string, step: string) =>
    `import-${manifest.project_id}-${item}-${step}`
  const writes = (item: string, step: string) =>
    ctx.writeOptions(key(item, step))
  const created = new Map<string, string>()
  const publishedOnCreate = new Set<string>()
  let droppedAssets = 0
  const failed: { collection: string; record: string; error: ErrorBody }[] = []
  const loaded: {
    slug: string
    kinds: FieldKinds
    records: RecordModel[]
    drafts: NoheadDraft[]
  }[] = []
  const attempt = async (
    collection: string,
    item: string,
    action: () => Promise<unknown>
  ) => {
    try {
      await action()
      return true
    } catch (error) {
      failed.push({ collection, record: item, error: itemError(error) })
      return false
    }
  }

  const exportedIds = new Set(
    [...exported.values()].flatMap(({ records }) => records.map((r) => r.id))
  )
  // Exported record ID -> the relation fields still to set on its copy.
  const deferred = new Map<string, string[]>()
  // Records whose copies got relation values, on create or afterwards.
  const linked = new Set<string>()
  const filled = (value: unknown) =>
    Array.isArray(value) ? value.length > 0 : value != null
  const slugs = manifest.collections.map((c) => c.slug)
  for (const slug of creationOrder(slugs, schema)) {
    const spec = schema.find((c) => c.slug === slug)
    const collectionId = collectionIds.get(slug)
    const content = exported.get(slug)
    if (!spec || !collectionId || !content) continue
    const kinds = fieldKinds(spec)
    loaded.push({ slug, kinds, ...content })

    for (const record of content.records) {
      const { data, dropped } = importedValues(record.data, kinds, assetIds)
      droppedAssets += dropped
      const { now, later } = relationsAtCreate(
        record.data,
        kinds,
        created,
        exportedIds
      )
      const publish = publishesOnCreate(record, later)
      await attempt(slug, record.id, async () => {
        const copy = await unwrap(
          ctx.api.records.create(
            collectionId,
            { data: { ...data, ...now }, ...(publish && { publish }) },
            writes(record.id, "create")
          )
        )
        created.set(record.id, copy.id)
        if (publish) publishedOnCreate.add(record.id)
        if (later.length > 0) deferred.set(record.id, later)
        if (Object.values(now).some(filled)) linked.add(record.id)
      })
    }
  }

  let published = publishedOnCreate.size
  for (const { slug, kinds, records } of loaded) {
    for (const record of records) {
      const copy = created.get(record.id)
      if (!copy || publishedOnCreate.has(record.id)) continue
      const relations = Object.fromEntries(
        (deferred.get(record.id) ?? []).map((field) => [
          field,
          record.data[field],
        ])
      )
      const { data: links } = importedValues(
        relations,
        kinds,
        assetIds,
        created
      )
      if (
        Object.keys(links).length > 0 &&
        (await attempt(slug, record.id, () =>
          unwrap(
            ctx.api.records.update(
              copy,
              { data: links },
              writes(record.id, "relations")
            )
          )
        ))
      )
        linked.add(record.id)
      if (
        record.published_at &&
        (await attempt(slug, record.id, () =>
          unwrap(ctx.api.records.publish(copy, writes(record.id, "publish")))
        ))
      )
        published++
      if (record.deleted_at)
        await attempt(slug, record.id, () =>
          unwrap(ctx.api.records.delete(copy, writes(record.id, "delete")))
        )
    }
  }

  let drafts = 0
  const now = ctx.runtime.now().getTime()
  for (const { slug, kinds, drafts: exportedDrafts } of loaded) {
    for (const draft of exportedDrafts) {
      // A draft whose record failed to import has nowhere to go; the record's
      // failure is reported already.
      const copy = created.get(draft.record_id)
      if (!copy) continue
      const changed = Object.fromEntries(
        draft.changed_fields
          .filter((field) => field in draft.data)
          .map((field) => [field, draft.data[field]])
      )
      const { data, dropped } = importedValues(
        changed,
        kinds,
        assetIds,
        created
      )
      droppedAssets += dropped
      const mergeAt = draft.schedule.merge_at
      const imported = await attempt(slug, draft.id, async () => {
        const started = await unwrap(
          ctx.api.drafts.create(copy, { data }, writes(draft.id, "draft"))
        )
        // A merge time that has passed is not made up for.
        if (mergeAt && Date.parse(mergeAt) > now)
          await unwrap(
            ctx.api.drafts.schedule(
              started.id,
              { merge_at: mergeAt },
              writes(draft.id, "draft-schedule")
            )
          )
      })
      if (imported) drafts++
    }
  }

  return {
    collections: loaded.length,
    created: created.size,
    relinked: linked.size,
    published,
    drafts,
    droppedAssets,
    failed,
  }
}

/**
 * A rich text document with its images' asset IDs mapped to the imported
 * copies'; images of assets that were not copied are left out. Images go
 * between a document's blocks, so only those are looked at.
 */
export function remapImages(
  value: unknown,
  map: (id: unknown) => string | undefined
): { document: unknown; dropped: number } {
  const document = value as { content?: unknown } | null
  if (!document || !Array.isArray(document.content))
    return { document: value, dropped: 0 }
  let dropped = 0
  const content = document.content.flatMap((node: unknown) => {
    const image = node as { type?: unknown; attrs?: Record<string, unknown> }
    if (image?.type !== "image" || !image.attrs || !("asset_id" in image.attrs))
      return [node]
    const id = map(image.attrs.asset_id)
    if (id === undefined) {
      dropped += 1
      return []
    }
    return [{ ...image, attrs: { ...image.attrs, asset_id: id } }]
  })
  return { document: { ...document, content }, dropped }
}
