import type { Command } from "commander"

import type {
  Collection,
  FieldCreate,
  FieldMigrationPreview,
} from "@nohead/sdk"
import type { CommandContext } from "../context.ts"
import { CliError, ExitCode, unwrap } from "../errors.ts"
import { readSource, usageError } from "../input.ts"
import { printNotice, printResult } from "../output.ts"
import {
  fromCollections,
  fromYaml,
  toYaml,
  type FieldSpec,
} from "../schema/format.ts"
import {
  applicable,
  describeChange,
  planChanges,
  type Change,
} from "../schema/plan.ts"
import { counts, waitFor } from "./migrations.ts"

const DEFAULT_FILE = "nohead.schema.yaml"

/** Every active collection in the project, across pages. */
export async function remoteCollections(
  ctx: CommandContext
): Promise<Collection[]> {
  return unwrap(
    Array.fromAsync((await ctx.project()).collections.list({ limit: 100 }))
  )
}

async function plan(ctx: CommandContext, file: string) {
  const desired = fromYaml(await readSource(ctx.runtime, file), file)
  const remote = await remoteCollections(ctx)
  return {
    remote,
    changes: planChanges(desired, fromCollections(remote), remote),
  }
}

function describePlan(changes: Change[]): string {
  if (applicable(changes).length === 0)
    return ["Schema is up to date.", ...changes.map(describeChange)].join("\n")
  return changes.map(describeChange).join("\n")
}

/** Field IDs by collection slug, then API key, as the push learns them. */
type FieldIds = Map<string, Map<string, string>>

function fieldIdsOf(collections: Collection[]): FieldIds {
  return new Map(
    collections.map((c) => [
      c.slug,
      new Map(c.fields.map((f) => [f.key, f.id])),
    ])
  )
}

/** A field spec as an API field definition; relation targets resolve slug -> ID. */
function fieldBody(field: FieldSpec, ids: Map<string, string>): FieldCreate {
  const { collection, ...rest } = field.options
  const configuration: Record<string, unknown> = { ...rest }
  if (typeof collection === "string") {
    const target =
      ids.get(collection) ??
      (collection.startsWith("col_") ? collection : undefined)
    if (!target)
      throw usageError(
        `Field ${field.key}: no collection "${collection}" in the project or the file`
      )
    configuration.target_collection_id = target
  }
  return {
    name: field.name,
    key: field.key,
    type: field.type,
    required: field.required,
    multiple: field.multiple,
    configuration,
  } as FieldCreate // any type's options; the API checks them against the type
}

type MigrateChange = Extract<Change, { kind: "migrate_field" }>
type UpdateChange = Extract<Change, { kind: "update_field" }>

/**
 * A field migration for a change. A unique target is refused while values
 * would be shared (`duplicate_values`), dry runs included.
 */
function migrationBody(
  change: MigrateChange | UpdateChange,
  ids: Map<string, string>,
  clearInvalid: boolean
) {
  const { type, multiple, required, configuration } = fieldBody(change.to, ids)
  return {
    type,
    multiple,
    required,
    configuration,
    on_invalid: clearInvalid ? ("clear" as const) : ("fail" as const),
  }
}

/**
 * Changes that can tighten a field: becoming required, or new options (a
 * shorter max_length, fewer enum options). The API refuses them while records
 * would violate the new settings, so they are dry-run like migrations first.
 */
function tightens(change: Change): change is UpdateChange {
  return (
    change.kind === "update_field" &&
    (change.changes.required === true || change.changes.options !== undefined)
  )
}

/** Dry runs of the plan's field migrations: what each would do to records. */
async function previewMigrations(
  ctx: CommandContext,
  remote: Collection[],
  todo: Change[],
  { clearInvalid }: { clearInvalid: boolean }
): Promise<{ change: MigrateChange; preview: FieldMigrationPreview }[]> {
  const ids = new Map(remote.map((c) => [c.slug, c.id]))
  const previews = []
  for (const change of todo) {
    if (change.kind !== "migrate_field") continue
    const preview = await unwrap(
      ctx.api.migrations.create(ids.get(change.slug) ?? change.slug, {
        field_id: change.field_id,
        ...migrationBody(change, ids, clearInvalid),
        dry_run: true,
      })
    )
    previews.push({ change, preview })
  }
  return previews
}

/**
 * Applies a plan (see planChanges): collections first (relations to new
 * collections once those exist), then collection and field changes, then field
 * migrations one at a time, each waited for. Migrations are previewed before
 * anything is changed. Returns the number of changes applied and slug -> ID.
 */
export async function applyPlan(
  ctx: CommandContext,
  remote: Collection[],
  todo: Change[],
  options: { clearInvalid: boolean }
): Promise<{ applied: number; ids: Map<string, string> }> {
  const ids = new Map(remote.map((c) => [c.slug, c.id]))
  const fieldIds = fieldIdsOf(remote)
  const migrations = todo.filter((c) => c.kind === "migrate_field")

  // Check tightening changes before changing anything. (Duplicates for a new
  // `unique` refuse the dry run.)
  for (const change of todo.filter(tightens)) {
    const preview = await unwrap(
      ctx.api.migrations.create(ids.get(change.slug) ?? change.slug, {
        field_id: change.field_id,
        ...migrationBody(change, ids, false),
        dry_run: true,
      })
    )
    if (preview.records.invalid > 0)
      throw new CliError(ExitCode.ApiError, {
        type: "validation_error",
        message: `${change.slug}.${change.key}: ${preview.records.invalid} record(s) do not meet the new settings (missing or no longer valid values). Nothing was changed; fix them, or migrate the field with a backfill (nohead fields migrate --help).`,
      })
  }

  // Preview every migration before changing anything.
  for (const { change, preview } of await previewMigrations(
    ctx,
    remote,
    todo,
    options
  )) {
    if (preview.records.invalid > 0 && !options.clearInvalid) {
      throw new CliError(ExitCode.ApiError, {
        type: "validation_error",
        message: `${change.slug}.${change.key}: ${preview.records.invalid} record(s) have values that cannot be converted. Nothing was changed; fix them or push with --clear-invalid.`,
      })
    }
  }

  const writes = ctx.writeOptions(null)
  let applied = 0
  const creates = todo.filter((c) => c.kind === "create_collection")
  const creating = new Set(creates.map((c) => c.collection.slug))
  // Relations to collections created in this push are added once those exist.
  const deferred: { slug: string; field: FieldSpec }[] = []
  for (const change of creates) {
    const now: FieldSpec[] = []
    for (const field of change.collection.fields) {
      const target = field.options.collection
      if (
        typeof target === "string" &&
        creating.has(target) &&
        !ids.has(target)
      )
        deferred.push({ slug: change.collection.slug, field })
      else now.push(field)
    }
    const created = await unwrap(
      (await ctx.project()).collections.create(
        {
          name: change.collection.name,
          slug: change.collection.slug,
          description: change.collection.description,
          public_search: change.collection.public_search,
          fields: now.map((f) => fieldBody(f, ids)),
        },
        writes
      )
    )
    ids.set(created.slug, created.id)
    fieldIds.set(
      created.slug,
      new Map(created.fields.map((f) => [f.key, f.id]))
    )
    applied++
  }
  for (const { slug, field } of deferred) {
    const added = await unwrap(
      ctx.api.fields.create(ids.get(slug)!, fieldBody(field, ids), writes)
    )
    fieldIds.get(slug)?.set(added.key, added.id)
  }

  for (const change of todo) {
    switch (change.kind) {
      case "update_collection":
        await unwrap(
          ctx.api.collections.update(
            change.id,
            {
              ...(change.name !== undefined ? { name: change.name } : {}),
              ...(change.description !== undefined
                ? { description: change.description }
                : {}),
              ...(change.public_search !== undefined
                ? { public_search: change.public_search }
                : {}),
            },
            writes
          )
        )
        break
      case "add_field": {
        const added = await unwrap(
          ctx.api.fields.create(
            ids.get(change.slug)!,
            fieldBody(change.field, ids),
            writes
          )
        )
        fieldIds.get(change.slug)?.set(added.key, added.id)
        break
      }
      case "update_field": {
        const { key, name, required, options: fieldOptions } = change.changes
        const configuration = fieldOptions
          ? fieldBody(
              {
                key: change.key,
                name: "",
                type: "text",
                required: false,
                multiple: false,
                options: fieldOptions,
              },
              ids
            ).configuration
          : undefined
        await unwrap(
          ctx.api.fields.update(
            change.field_id,
            {
              key,
              name,
              required,
              ...(configuration ? { configuration } : {}),
            },
            writes
          )
        )
        // Later lookups use the new key.
        if (key) {
          const known = fieldIds.get(change.slug)
          known?.delete(change.key)
          known?.set(key, change.field_id)
        }
        break
      }
      case "reorder_fields": {
        // A reorder lists every field, so it fails if they changed since the
        // plan (another push, the web app); what was applied stays.
        const changed = new CliError(ExitCode.ApiError, {
          type: "schema_changed",
          message: `${change.slug}: its fields changed during the push, so they were not put in the file's order. Run the push again.`,
        })
        const known = fieldIds.get(change.slug)
        const ordered = change.api_keys.map((key) => known?.get(key))
        if (ordered.some((id) => id === undefined)) throw changed
        try {
          await unwrap(
            ctx.api.fields.reorder(
              change.id,
              { field_ids: ordered as string[] },
              writes
            )
          )
        } catch (error) {
          if (
            error instanceof CliError &&
            error.body.details?.some((d) => d.field === "field_ids")
          )
            throw changed
          throw error
        }
        break
      }
      default:
        continue
    }
    applied++
  }

  // Migrations last and one at a time: each makes its collection read-only.
  for (const change of migrations) {
    if (change.kind !== "migrate_field") continue
    const started = await unwrap(
      ctx.api.migrations.create(
        ids.get(change.slug) ?? change.slug,
        {
          field_id: change.field_id,
          ...migrationBody(change, ids, options.clearInvalid),
        },
        writes
      )
    )
    if (started.object !== "field_migration") continue
    const finished = await waitFor(ctx, started)
    if (finished.status !== "complete")
      throw new CliError(ExitCode.ApiError, {
        type: `migration_${finished.status}`,
        message: `${change.slug}.${change.key}: migration ${finished.status}${finished.failure ? `: ${finished.failure.message}` : ""}`,
      })
    applied++
  }
  return { applied, ids }
}

export function registerSchema(
  program: Command,
  context: () => CommandContext
) {
  const schema = program
    .command("schema")
    .description(
      "Keep the project's collections and fields in a file (schema as code)"
    )

  schema
    .command("pull")
    .description(
      `Write the project's schema to a file (default ${DEFAULT_FILE}; - for stdout)`
    )
    .option("--output <file>", "where to write it", DEFAULT_FILE)
    .action(async (options: { output: string }) => {
      const ctx = context()
      const collections = fromCollections(await remoteCollections(ctx))
      const yaml = toYaml(collections)
      if (options.output === "-") {
        ctx.runtime.stdout(yaml)
        return
      }
      await ctx.runtime.writeFile(options.output, yaml)
      printResult(
        ctx,
        { file: options.output, collections: collections.length },
        () => `Wrote ${collections.length} collections to ${options.output}`
      )
    })

  schema
    .command("diff")
    .description("Show what push would change")
    .argument("[file]", "schema file", DEFAULT_FILE)
    .option("--exit-code", "exit 1 when there are changes", false)
    .option("--no-preview", "skip dry runs of field migrations")
    .action(
      async (
        file: string,
        options: { exitCode: boolean; preview: boolean }
      ) => {
        const ctx = context()
        const { changes, remote } = await plan(ctx, file)
        const previews = options.preview
          ? await previewMigrations(ctx, remote, changes, {
              clearInvalid: false,
            })
          : []
        const migrations = previews.map(({ change, preview }) => ({
          collection: change.slug,
          field: change.key,
          conversion: preview.conversion,
          records: preview.records,
        }))
        printResult(ctx, { changes, migrations }, () =>
          [
            describePlan(changes),
            ...previews.map(
              ({ change, preview }) =>
                `\n${change.slug}.${change.key} migration preview (${preview.conversion}): ${preview.records.total} ${preview.records.total === 1 ? "record" : "records"}, ${counts(preview.records) || "nothing to change"}${preview.records.invalid > 0 ? "\n  Values that cannot be converted block the push unless you pass --clear-invalid; see `nohead fields migrate --dry-run`." : ""}`
            ),
          ].join("")
        )
        if (options.exitCode && applicable(changes).length > 0)
          throw new CliError(ExitCode.ApiError, {
            type: "schema_differs",
            message: "The project's schema differs from the file",
          })
      }
    )

  schema
    .command("push")
    .description(
      "Change the project's schema to match the file (never deletes anything)"
    )
    .argument("[file]", "schema file", DEFAULT_FILE)
    .option(
      "--yes",
      "apply the changes (without it, push only shows them)",
      false
    )
    .option(
      "--allow-migrations",
      "allow type and multiple changes, which rewrite record values",
      false
    )
    .option(
      "--clear-invalid",
      "in migrations, clear values that cannot be converted",
      false
    )
    .action(
      async (
        file: string,
        options: {
          yes: boolean
          allowMigrations: boolean
          clearInvalid: boolean
        }
      ) => {
        const ctx = context()
        const { remote, changes } = await plan(ctx, file)
        const todo = applicable(changes)
        if (todo.length === 0) {
          printResult(ctx, { changes, applied: 0 }, () => describePlan(changes))
          return
        }
        printNotice(ctx, describePlan(changes))

        const migrations = todo.filter((c) => c.kind === "migrate_field")
        if (migrations.length > 0 && !options.allowMigrations) {
          throw new CliError(ExitCode.Usage, {
            type: "invalid_request",
            message:
              "The file changes field types or multiple; these rewrite record values. Review them with `nohead fields migrate --dry-run`, then push with --allow-migrations.",
          })
        }
        if (!options.yes)
          throw new CliError(ExitCode.Usage, {
            type: "invalid_request",
            message:
              "Nothing was changed. Run again with --yes to apply this plan.",
          })

        const { applied } = await applyPlan(ctx, remote, todo, options)

        printResult(
          ctx,
          { changes, applied },
          () => `Applied ${applied} change${applied === 1 ? "" : "s"}.`
        )
      }
    )
}
