import { createHash } from "node:crypto"

import type { Command } from "commander"

import type {
  Change,
  ConditionalRequestOptions,
  NoheadRecord as RecordModel,
  RecordBatch,
  RecordBatchRequest,
  RecordFilter,
  RecordListParams,
  RecordRevision,
  RecordSchedule,
  RevertPreview,
  ScheduledChange,
} from "@nohead/sdk"
import type { CommandContext } from "../context.ts"
import {
  CliError,
  ExitCode,
  unwrap,
  unwrapAll,
  type ErrorBody,
} from "../errors.ts"
import {
  collect,
  ifMatch,
  parseJsonObject,
  parseTime,
  positiveInteger,
  readData,
  readSource,
  usageError,
} from "../input.ts"
import {
  details,
  formatValue,
  printNotice,
  printResult,
  table,
  toJsonLines,
} from "../output.ts"
import { parseFilters } from "../filters.ts"
import { pageQuery, printList, withPaging, type PageOptions } from "../pages.ts"

interface ListOptions extends PageOptions {
  status?: string
  filter?: string[]
  deleted: boolean
  sort?: string
  expand?: string
}

export interface DataOptions {
  data?: string
  dataFile?: string
  set?: string[]
}

export function withDataFlags(command: Command): Command {
  return command
    .option(
      "--set <key=value>",
      "set a field (key=text or key:=json); repeatable",
      collect
    )
    .option("--data <json>", "record data as a JSON object")
    .option(
      "--data-file <path>",
      "read record data from a JSON file (- for stdin)"
    )
}

const STATUSES = ["published", "unpublished"]

function listQuery(options: ListOptions): RecordListParams {
  const filter: RecordFilter = parseFilters(options.filter)
  if (options.status) {
    if (!STATUSES.includes(options.status))
      throw usageError(`--status must be one of ${STATUSES.join(", ")}`)
    filter.published_at = { exists: options.status === "published" }
  }
  if (options.deleted) filter.deleted = true
  return {
    filter,
    sort: options.sort,
    ...pageQuery(options),
    expand: options.expand?.split(","),
  }
}

/** Every page, following cursors. */
export function allRecords(
  ctx: CommandContext,
  collection: string,
  query: RecordListParams
): Promise<RecordModel[]> {
  return unwrapAll(ctx.api.records.list(collection, query))
}

function label(record: RecordModel): string {
  const value = Object.values(record.data).find(
    (v) => typeof v === "string" && v.trim()
  )
  return typeof value === "string" ? formatValue(value, 50) : ""
}

/** deleted, published or unpublished. */
export function recordStatus(record: RecordModel): string {
  if (record.deleted_at) return "deleted"
  return record.published_at ? "published" : "unpublished"
}

function recordTable(records: RecordModel[]): string {
  return table(
    ["ID", "STATUS", "REV", "UPDATED", "TITLE"],
    records.map((r) => [
      r.id,
      recordStatus(r),
      String(r.revision),
      r.updated_at,
      label(r),
    ])
  )
}

/** The record's schedule; the API answers 404 `not_scheduled` without one. */
async function scheduleOf(
  ctx: CommandContext,
  id: string
): Promise<RecordSchedule> {
  try {
    return await unwrap(ctx.api.records.getSchedule(id))
  } catch (error) {
    const none = { publish_at: null, unpublish_at: null, last_error: null }
    if (
      error instanceof CliError &&
      error.body.details?.some((d) => d.code === "not_scheduled")
    )
      return { object: "schedule", record_id: id, ...none }
    throw error
  }
}

function scheduleText(schedule: RecordSchedule): string {
  const { publish_at, unpublish_at } = schedule
  const parts = [
    publish_at && `publishes at ${publish_at}`,
    unpublish_at && `unpublishes at ${unpublish_at}`,
  ].filter(Boolean)
  return parts.length
    ? `${schedule.record_id} ${parts.join(", ")}`
    : `${schedule.record_id} has no schedule`
}

function recordDetails(
  record: RecordModel,
  schedule: RecordSchedule | null
): string {
  const optional = (label: string, value: unknown): [string, unknown][] =>
    value ? [[label, value]] : []
  return details([
    ["id", record.id],
    ["status", recordStatus(record)],
    ["revision", record.revision],
    ["published at", record.published_at],
    ...optional("publishes at", schedule?.publish_at),
    ...optional("unpublishes at", schedule?.unpublish_at),
    ...optional("schedule error", schedule?.last_error),
    ...optional("purged after", record.purge_after),
    ["updated at", record.updated_at],
    ...Object.entries(record.data),
  ])
}

function changesText(changes: Change[]): string {
  if (changes.length === 0) return "No changes."
  return changes
    .map((c) => {
      const name = c.attribute ?? c.field ?? c.field_id ?? "?"
      const arrow =
        c.kind === "added"
          ? formatValue(c.after)
          : c.kind === "removed"
            ? `${formatValue(c.before)} (removed)`
            : `${formatValue(c.before)} → ${formatValue(c.after)}`
      return `${name} (${c.kind}${c.field_deleted ? ", field deleted" : ""}): ${arrow}`
    })
    .join("\n")
}

/** Lifecycle actions that share one shape: <id> [--if-revision]. */
function lifecycle(
  records: Command,
  context: () => CommandContext,
  name: string,
  description: string,
  call: (
    ctx: CommandContext,
    id: string,
    options: ConditionalRequestOptions
  ) => Promise<RecordModel>,
  done: (record: RecordModel) => string,
  { guarded = true }: { guarded?: boolean } = {}
) {
  const command = records
    .command(name)
    .description(description)
    .argument("<id>", "record ID")
  if (guarded)
    command.option(
      "--if-revision <n>",
      "fail with 412 unless the record is still at this revision"
    )
  command.action(async (id: string, options: { ifRevision?: string }) => {
    const ctx = context()
    const record = await call(ctx, id, {
      ...ctx.writeOptions(),
      ...ifMatch(options.ifRevision),
    })
    printResult(ctx, record, () => done(record))
  })
}

export function registerRecords(
  program: Command,
  context: () => CommandContext
) {
  const records = program
    .command("records")
    .description("Manage records and their history")

  withPaging(
    records
      .command("list")
      .description("List records (newest first by default)")
      .argument("<collection>", "collection slug or ID")
      .option("--status <status>", "published or unpublished")
      .option(
        "--filter <expression>",
        'filter, e.g. price<50, released>=today, "category in shoes,bags", "cover exists", "published_at exists"; repeatable',
        collect
      )
      .option("--deleted", "list deleted records instead", false)
      .option(
        "--sort <sort>",
        "created_at, updated_at, published_at, id or a field; prefix - for descending"
      ),
    "record"
  )
    .option(
      "--expand <fields>",
      "relation fields whose records to embed (comma-separated)"
    )
    .action(async (collection: string, options: ListOptions) => {
      const ctx = context()
      const query = listQuery(options)
      await printList(
        ctx,
        options.all,
        () => ctx.api.records.list(collection, query),
        recordTable
      )
    })

  withDataFlags(
    records
      .command("bulk")
      .description(
        "Publish, unpublish, delete, restore or update many records; each gets its own revision"
      )
      .argument("<action>", "publish, unpublish, delete, restore or update")
      .argument("<collection>", "collection slug or ID")
      .argument(
        "[ids...]",
        "record IDs (or select with --status/--filter/--every)"
      )
      .option("--status <status>", "select records with this status")
      .option(
        "--filter <expression>",
        "select records by filter, as in records list; repeatable",
        collect
      )
      .option("--deleted", "select deleted records (for restore)", false)
      .option("--every", "select every record in the collection", false)
  ).action(
    async (
      action: string,
      collection: string,
      ids: string[],
      options: ListOptions & DataOptions & { every: boolean }
    ) => {
      const ctx = context()
      const actions = ["publish", "unpublish", "delete", "restore", "update"]
      if (!actions.includes(action))
        throw usageError(`action must be one of ${actions.join(", ")}`)
      const selecting =
        Boolean(options.status || options.filter?.length || options.deleted) ||
        options.every
      if (ids.length > 0 && selecting)
        throw usageError("Give record IDs or a selection, not both")
      if (ids.length === 0 && !selecting)
        throw usageError(
          "Give record IDs, or select records with --status, --filter, --deleted or --every"
        )
      const data =
        action === "update" ? await readData(ctx.runtime, options) : undefined
      const targets =
        ids.length > 0
          ? ids
          : (
              await allRecords(
                ctx,
                collection,
                listQuery({ ...options, all: true })
              )
            ).map((record) => record.id)

      const results: RecordBatch["results"] = []
      for (let i = 0; i < targets.length; i += 100) {
        const result = await unwrap(
          ctx.api.records.bulk(
            collection,
            {
              action: action as RecordBatchRequest["action"],
              record_ids: targets.slice(i, i + 100),
              ...(data ? { data } : {}),
            },
            ctx.writeOptions()
          )
        )
        results.push(...result.results)
      }
      const failed = results.filter((r) => r.status === "failed")
      const changed = results.filter(
        (r) => r.status === "succeeded" && r.changed
      )
      const summary = {
        object: "bulk_result",
        action,
        succeeded: results.length - failed.length,
        failed: failed.length,
        results,
      }
      printResult(ctx, summary, () =>
        [
          `${action}: ${changed.length} changed, ${summary.succeeded - changed.length} unchanged, ${failed.length} failed`,
          ...failed.map(
            (r) => `  ${r.id}: ${"error" in r ? r.error.message : ""}`
          ),
        ].join("\n")
      )
      if (failed.length > 0)
        throw new CliError(ExitCode.ApiError, {
          type: "bulk_partial_failure",
          message: `${failed.length} of ${results.length} records failed`,
        })
    }
  )

  records
    .command("get")
    .description("Show a record")
    .argument("<id>", "record ID")
    .option(
      "--expand <fields>",
      "relation fields whose records to embed (comma-separated)"
    )
    .action(async (id: string, options: { expand?: string }) => {
      const ctx = context()
      const [record, schedule] = await Promise.all([
        unwrap(ctx.api.records.get(id, { expand: options.expand?.split(",") })),
        // Published-only keys may not read schedules: show the record.
        scheduleOf(ctx, id).catch((error: unknown) => {
          if (
            error instanceof CliError &&
            error.body.type === "authorization_error"
          )
            return null
          throw error
        }),
      ])
      printResult(ctx, record, () => recordDetails(record, schedule))
    })

  withDataFlags(
    records
      .command("create")
      .description("Create an unpublished record")
      .argument("<collection>", "collection slug or ID")
  ).action(async (collection: string, options: DataOptions) => {
    const ctx = context()
    const data = await readData(ctx.runtime, options)
    const record = await unwrap(
      ctx.api.records.create(collection, { data }, ctx.writeOptions())
    )
    printResult(
      ctx,
      record,
      () => `Created ${record.id} (revision ${record.revision}, unpublished)`
    )
  })

  withDataFlags(
    records
      .command("update")
      .description(
        "Update a record; only the given fields change (null clears one)"
      )
      .argument("<id>", "record ID")
      .option(
        "--if-revision <n>",
        "fail with 412 unless the record is still at this revision"
      )
  ).action(
    async (id: string, options: DataOptions & { ifRevision?: string }) => {
      const ctx = context()
      const data = await readData(ctx.runtime, options)
      const record = await unwrap(
        ctx.api.records.update(
          id,
          { data },
          { ...ctx.writeOptions(), ...ifMatch(options.ifRevision) }
        )
      )
      printResult(
        ctx,
        record,
        () => `Updated ${record.id} (revision ${record.revision})`
      )
    }
  )

  lifecycle(
    records,
    context,
    "publish",
    "Publish a record",
    (ctx, id, options) => unwrap(ctx.api.records.publish(id, options)),
    (r) => `Published ${r.id} (revision ${r.revision})`
  )
  lifecycle(
    records,
    context,
    "unpublish",
    "Unpublish a record",
    (ctx, id, options) => unwrap(ctx.api.records.unpublish(id, options)),
    (r) => `Unpublished ${r.id} (revision ${r.revision})`
  )
  records
    .command("schedule")
    .description(
      "Publish or unpublish a record later (the change happens within a minute of the time)"
    )
    .argument("<id>", "record ID")
    .option(
      "--publish-at <time>",
      "ISO 8601 time, +2h / +3d, or none; left out, it stays as it is"
    )
    .option(
      "--unpublish-at <time>",
      "ISO 8601 time, +2h / +3d, or none; left out, it stays as it is"
    )
    .action(
      async (
        id: string,
        options: { publishAt?: string; unpublishAt?: string }
      ) => {
        const ctx = context()
        if (
          options.publishAt === undefined &&
          options.unpublishAt === undefined
        )
          throw usageError("Pass --publish-at, --unpublish-at, or both")
        const now = ctx.runtime.now()
        const publishAt =
          options.publishAt === undefined
            ? undefined
            : parseTime(options.publishAt, "--publish-at", now)
        const unpublishAt =
          options.unpublishAt === undefined
            ? undefined
            : parseTime(options.unpublishAt, "--unpublish-at", now)
        // The API replaces the whole schedule; a time left out keeps its value.
        const current =
          publishAt === undefined || unpublishAt === undefined
            ? await scheduleOf(ctx, id)
            : undefined
        const schedule = await unwrap(
          ctx.api.records.schedule(
            id,
            {
              publish_at:
                publishAt === undefined ? current!.publish_at : publishAt,
              unpublish_at:
                unpublishAt === undefined ? current!.unpublish_at : unpublishAt,
            },
            ctx.writeOptions()
          )
        )
        printResult(ctx, schedule, () => scheduleText(schedule))
      }
    )

  records
    .command("unschedule")
    .description("Cancel a record's scheduled publish and unpublish")
    .argument("<id>", "record ID")
    .action(async (id: string) => {
      const ctx = context()
      const schedule = await unwrap(
        ctx.api.records.unschedule(id, ctx.writeOptions())
      )
      printResult(
        ctx,
        schedule,
        () => `Cancelled the schedule of ${schedule.record_id}`
      )
    })

  withPaging(
    records
      .command("scheduled")
      .description(
        "List a collection's scheduled publishes, unpublishes and draft merges, soonest first"
      )
      .argument("<collection>", "collection slug or ID")
      .option("--sort <sort>", "at (soonest first, the default) or -at"),
    "change"
  ).action(
    async (collection: string, options: PageOptions & { sort?: string }) => {
      const ctx = context()
      let sort: "at" | "-at" | undefined
      if (options.sort === "at" || options.sort === "-at") sort = options.sort
      else if (options.sort !== undefined)
        throw usageError("--sort must be at or -at")
      const query = {
        ...(sort && { sort }),
        ...pageQuery(options),
      }
      await printList(
        ctx,
        options.all,
        () => ctx.api.records.scheduledChanges(collection, query),
        (changes: ScheduledChange[]) =>
          changes.length === 0
            ? "Nothing is scheduled."
            : table(
                ["WHEN", "ACTION", "RECORD", "DRAFT"],
                changes.map((c) => [
                  c.at,
                  c.action,
                  c.record_id,
                  c.draft_id ?? "",
                ])
              )
      )
    }
  )

  lifecycle(
    records,
    context,
    "delete",
    "Delete a record (values and history are kept)",
    (ctx, id, options) => unwrap(ctx.api.records.delete(id, options)),
    (r) => `Deleted ${r.id}. Undo with: nohead records restore ${r.id}`
  )
  lifecycle(
    records,
    context,
    "restore",
    "Restore a deleted record",
    (ctx, id, options) => unwrap(ctx.api.records.restore(id, options)),
    (r) => `Restored ${r.id} (revision ${r.revision})`,
    { guarded: false }
  )

  withPaging(
    records
      .command("history")
      .description("Show a record's revisions, newest first")
      .argument("<id>", "record ID")
      .option("--operation <op>", "only this operation (update, publish, ...)")
      .option(
        "--actor <id>",
        "only changes by this user (usr_...) or API key (key_...)"
      )
      .option("--since <time>", "only changes at or after this ISO 8601 time")
      .option("--until <time>", "only changes before this ISO 8601 time"),
    "revision"
  ).action(
    async (
      id: string,
      options: PageOptions & {
        operation?: RecordRevision["operation"]
        actor?: string
        since?: string
        until?: string
      }
    ) => {
      const ctx = context()
      const createdAt = {
        ...(options.since ? { gte: options.since } : {}),
        ...(options.until ? { lt: options.until } : {}),
      }
      const filter = {
        ...(options.operation ? { operation: options.operation } : {}),
        ...(options.actor ? { actor_id: options.actor } : {}),
        ...(Object.keys(createdAt).length ? { created_at: createdAt } : {}),
      }
      const query = {
        ...pageQuery(options),
        ...(Object.keys(filter).length ? { filter } : {}),
      }
      await printList(
        ctx,
        options.all,
        () => ctx.api.records.revisions.list(id, query),
        (items) =>
          table(
            ["REV", "OPERATION", "ACTOR", "VIA", "CHANGED", "WHEN", "NOTE"],
            items.map((r) => [
              String(r.revision),
              r.operation +
                (r.reverted_to_revision ? ` to ${r.reverted_to_revision}` : ""),
              r.actor.name ?? r.actor.type,
              r.via,
              r.changed_fields.join(", "),
              r.created_at,
              r.note ?? "",
            ])
          )
      )
    }
  )

  records
    .command("revision")
    .description("Show one revision: the record as it was, and what changed")
    .argument("<id>", "record ID")
    .argument("<revision>", "revision number")
    .action(async (id: string, number: string) => {
      const ctx = context()
      const revision = await unwrap(
        ctx.api.records.revisions.get(id, positiveInteger(number, "<revision>"))
      )
      printResult(ctx, revision, () =>
        [
          details([
            ["revision", revision.revision],
            ["operation", revision.operation],
            ["actor", revision.actor.name ?? revision.actor.type],
            ["via", revision.via],
            ["status", revision.published_at ? "published" : "unpublished"],
            ["when", revision.created_at],
            ["note", revision.note],
          ]),
          "",
          "Data:",
          details(Object.entries(revision.data)),
          "",
          "Changes:",
          changesText(revision.changes),
        ].join("\n")
      )
    })

  records
    .command("diff")
    .description("Compare two revisions")
    .argument("<id>", "record ID")
    .requiredOption("--from <revision>", "older revision")
    .requiredOption("--to <revision>", "newer revision")
    .action(async (id: string, options: { from: string; to: string }) => {
      const ctx = context()
      const diff = await unwrap(
        ctx.api.records.diff(id, {
          from: positiveInteger(options.from, "--from"),
          to: positiveInteger(options.to, "--to"),
        })
      )
      printResult(ctx, diff, () => changesText(diff.changes))
    })

  records
    .command("revert")
    .description(
      "Revert a record to an earlier revision (writes a new revision)"
    )
    .argument("<id>", "record ID")
    .argument("<revision>", "revision to revert to")
    .option("--dry-run", "show what would change without writing", false)
    .option(
      "--if-revision <n>",
      "fail with 412 unless the record is still at this revision"
    )
    .action(
      async (
        id: string,
        revision: string,
        options: { dryRun: boolean; ifRevision?: string }
      ) => {
        const ctx = context()
        const result = await unwrap(
          ctx.api.records.revisions.revert(
            id,
            positiveInteger(revision, "<revision>"),
            { dry_run: options.dryRun },
            { ...ctx.writeOptions(), ...ifMatch(options.ifRevision) }
          ) as PromiseLike<RecordModel | RevertPreview>
        )
        printResult(ctx, result, () =>
          result.object === "revert_preview"
            ? `Dry run: reverting to revision ${result.to_revision} would change:\n${changesText(result.changes)}`
            : `Reverted ${result.id} to revision ${revision} (now revision ${result.revision})`
        )
      }
    )

  records
    .command("export")
    .description("Export records as JSON Lines (one API record per line)")
    .argument("<collection>", "collection slug or ID")
    .option("--output <path>", "write to a file instead of stdout")
    .option("--status <status>", "published or unpublished")
    .option("--deleted", "export deleted records instead", false)
    .action(
      async (
        collection: string,
        options: { output?: string; status?: string; deleted: boolean }
      ) => {
        const ctx = context()
        const all = await allRecords(
          ctx,
          collection,
          listQuery({ ...options, all: true, sort: "created_at" })
        )
        const lines = toJsonLines(all)
        if (options.output) {
          await ctx.runtime.writeFile(options.output, lines)
          printResult(
            ctx,
            { exported: all.length, output: options.output },
            () => `Exported ${all.length} records to ${options.output}`
          )
        } else {
          ctx.runtime.stdout(lines)
          printNotice(ctx, `Exported ${all.length} records`)
        }
      }
    )

  records
    .command("import")
    .description(
      "Create records from JSON Lines (API records or plain data objects); - reads stdin"
    )
    .argument("<collection>", "collection slug or ID")
    .argument("<file>", "JSON Lines file, or - for stdin")
    .option(
      "--publish",
      "publish records whose line is an exported record with published_at",
      false
    )
    .action(
      async (
        collection: string,
        file: string,
        options: { publish: boolean }
      ) => {
        const ctx = context()
        const source = await readSource(ctx.runtime, file)
        const lines = source.split("\n").map((l) => l.trim())
        // Every line gets its own Idempotency-Key derived from the file, so
        // re-running an interrupted import within 24 hours skips what was done.
        const base =
          ctx.options.idempotencyKey ??
          `import-${createHash("sha256").update(`${collection}\n${source}`).digest("hex")}`
        const created: string[] = []
        const failed: { line: number; error: ErrorBody }[] = []

        for (const [index, line] of lines.entries()) {
          if (!line) continue
          try {
            const parsed = parseJsonObject(line, `line ${index + 1}`)
            const isRecord =
              parsed.object === "record" && typeof parsed.data === "object"
            const data = (isRecord ? parsed.data : parsed) as Record<
              string,
              unknown
            >
            const record = await unwrap(
              ctx.api.records.create(
                collection,
                { data },
                ctx.writeOptions(`${base}:${index}`)
              )
            )
            if (options.publish && isRecord && parsed.published_at) {
              await unwrap(
                ctx.api.records.publish(
                  record.id,
                  ctx.writeOptions(`${base}:${index}:publish`)
                )
              )
            }
            created.push(record.id)
          } catch (error) {
            if (
              !(error instanceof CliError) ||
              error.exitCode === ExitCode.Network
            )
              throw error
            failed.push({ line: index + 1, error: error.body })
          }
        }

        const result = { created: created.length, failed }
        printResult(ctx, result, () =>
          [
            `Imported ${created.length} records`,
            ...failed.map(
              (f) =>
                `  line ${f.line}: ${f.error.message}${(f.error.details ?? []).map((d) => ` (${d.field ?? ""} ${d.message})`).join("")}`
            ),
          ].join("\n")
        )
        if (failed.length > 0) {
          throw new CliError(ExitCode.ApiError, {
            type: "validation_error",
            message: `${failed.length} line(s) failed to import`,
          })
        }
      }
    )
}
