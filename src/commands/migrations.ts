import type { Command } from "commander"

import type {
  FieldDefinition,
  FieldMigration,
  FieldMigrationCounts,
  FieldMigrationPreview,
  FieldMigrationRequest,
} from "@nohead/sdk"
import type { CommandContext } from "../context.ts"
import { CliError, ExitCode, unwrap } from "../errors.ts"
import { usageError } from "../input.ts"
import { formatValue, printNotice, printResult, table } from "../output.ts"
import {
  configuration,
  fieldType,
  mergeConfiguration,
  resolveField,
  withConfigFlags,
  type ConfigOptions,
} from "./fields.ts"

// Small migrations finish within a second: poll soon, then back off to once a
// second.
const FIRST_POLL_MS = 100
const MAX_POLL_MS = 1000
const FINISHED = ["complete", "failed", "cancelled"]

function definition(d: FieldDefinition): string {
  const rules = [d.multiple && "multiple", d.required && "required"].filter(
    Boolean
  )
  const config = Object.keys(d.configuration).length
    ? ` ${JSON.stringify(d.configuration)}`
    : ""
  return `${d.type}${rules.length ? ` (${rules.join(", ")})` : ""}${config}`
}

export function counts(records: FieldMigrationCounts): string {
  return (
    ["converted", "backfilled", "cleared", "invalid", "unchanged"] as const
  )
    .filter((key) => records[key] > 0)
    .map((key) => `${records[key]} ${key}`)
    .join(", ")
}

function describePreview(preview: FieldMigrationPreview): string {
  const lines = [
    `${definition(preview.from)} -> ${definition(preview.to)} (${preview.conversion})`,
    `${preview.records.total} records: ${counts(preview.records) || "nothing to change"}`,
  ]
  if (preview.samples.length > 0) {
    lines.push(
      "",
      table(
        ["RECORD", "OUTCOME", "BEFORE", "AFTER"],
        preview.samples.map((s) => [
          `${s.record_id}${s.deleted_at ? " (deleted)" : ""}`,
          s.outcome,
          formatValue(s.before, 30),
          s.error ? s.error.message : formatValue(s.after, 30),
        ])
      )
    )
  }
  if (preview.records.invalid > 0)
    lines.push(
      "",
      "Fix these records, pass --backfill, or --clear-invalid to clear values that cannot be converted."
    )
  return lines.join("\n")
}

function describe(migration: FieldMigration): string {
  const lines = [
    `${migration.id}  ${migration.status}${migration.cancel_requested_at && migration.status === "running" ? " (cancelling)" : ""}`,
    `${definition(migration.from)} -> ${definition(migration.to)}`,
  ]
  if (migration.status === "complete")
    lines.push(
      `${migration.records.total} records: ${counts(migration.records) || "nothing changed"}`
    )
  if (migration.failure) lines.push(`Failed: ${migration.failure.message}`)
  return lines.join("\n")
}

/** Polls until the migration finishes; failed and cancelled ones exit non-zero. */
export async function waitFor(
  ctx: CommandContext,
  migration: FieldMigration
): Promise<FieldMigration> {
  let current = migration
  let reported = ""
  let delay = FIRST_POLL_MS
  while (!FINISHED.includes(current.status)) {
    if (current.status !== reported) {
      printNotice(ctx, `Migration ${current.id} is ${current.status}...`)
      reported = current.status
    }
    await ctx.runtime.sleep(delay)
    delay = Math.min(delay * 2, MAX_POLL_MS)
    current = await unwrap(ctx.api.migrations.get(current.id))
  }
  return current
}

function finish(ctx: CommandContext, migration: FieldMigration) {
  printResult(ctx, migration, () => describe(migration))
  if (migration.status === "failed" || migration.status === "cancelled") {
    throw new CliError(ExitCode.ApiError, {
      type: "migration_" + migration.status,
      message:
        migration.failure?.message ?? `Migration ${migration.id} was cancelled`,
    })
  }
}

/** --backfill is a string; --backfill-json any JSON value. */
function backfill(options: {
  backfill?: string
  backfillJson?: string
}): unknown {
  if (options.backfill !== undefined && options.backfillJson !== undefined)
    throw usageError("Pass either --backfill or --backfill-json, not both")
  if (options.backfillJson === undefined) return options.backfill
  try {
    return JSON.parse(options.backfillJson)
  } catch {
    throw usageError("--backfill-json expects JSON")
  }
}

export function registerMigrations(
  program: Command,
  context: () => CommandContext
) {
  const fields = program.commands.find((c) => c.name() === "fields")
  if (!fields) throw new Error("register fields before migrations")

  withConfigFlags(
    fields
      .command("migrate")
      .description(
        "Change a field in a way that rewrites record values, e.g. nohead fields migrate products price --type decimal --dry-run"
      )
      .argument("<collection>", "collection slug or ID")
      .argument("<field>", "field key or ID")
      .option("--type <type>", "new field type")
      .option("--multiple", "store a list of values")
      .option("--single", "store a single value")
      .option("--required", "make the field required (see --backfill)")
      .option("--optional", "make the field optional")
      .option("--backfill <text>", "value for records that have none")
      .option(
        "--backfill-json <json>",
        "value for records that have none, as JSON"
      )
      .option(
        "--clear-invalid",
        "clear values that cannot be converted instead of refusing",
        false
      )
      .option(
        "--days-in <zone>",
        "removing a date's time: the IANA zone whose day each moment falls on (default: the field's, else UTC)"
      )
      .option("--dry-run", "preview the outcome for every record", false)
      .option("--no-wait", "return once the migration is accepted")
  ).action(
    async (
      collection: string,
      ref: string,
      options: ConfigOptions & {
        type?: string
        multiple?: boolean
        single?: boolean
        required?: boolean
        optional?: boolean
        backfill?: string
        backfillJson?: string
        clearInvalid: boolean
        daysIn?: string
        dryRun: boolean
        wait: boolean
      }
    ) => {
      const ctx = context()
      if (options.multiple && options.single)
        throw usageError("Pass either --multiple or --single, not both")
      if (options.required && options.optional)
        throw usageError("Pass either --required or --optional, not both")

      const field = await resolveField(ctx, collection, ref)
      const config = await configuration(ctx, options)
      const body: Omit<FieldMigrationRequest, "field_id"> = {
        on_invalid: options.clearInvalid ? "clear" : "fail",
      }
      if (options.type) body.type = fieldType(options.type)
      if (options.multiple) body.multiple = true
      if (options.single) body.multiple = false
      if (options.required) body.required = true
      if (options.optional) body.required = false
      if (Object.keys(config).length > 0)
        // A type change starts from a clean configuration; otherwise merge.
        body.configuration = mergeConfiguration(
          body.type ? {} : field.configuration,
          config
        )
      const value = backfill(options)
      if (value !== undefined) body.backfill = value
      if (options.daysIn !== undefined) body.time_zone = options.daysIn

      const result = await unwrap(
        ctx.api.migrations.create(
          field.collection_id,
          { field_id: field.id, ...body, dry_run: options.dryRun },
          ctx.writeOptions()
        ) as PromiseLike<FieldMigration | FieldMigrationPreview>
      )
      if (result.object === "field_migration_preview") {
        printResult(ctx, result, () => describePreview(result))
        return
      }
      finish(ctx, options.wait ? await waitFor(ctx, result) : result)
    }
  )

  const migrations = program
    .command("migrations")
    .description("Follow and cancel field migrations")

  migrations
    .command("list")
    .description("List a collection's field migrations, newest first")
    .argument("<collection>", "collection slug or ID")
    .action(async (collection: string) => {
      const ctx = context()
      const page = await unwrap(
        ctx.api.migrations.list(collection, { limit: 100 })
      )
      printResult(ctx, page, () =>
        table(
          ["ID", "STATUS", "CHANGE", "CREATED"],
          page.data.map((m) => [
            m.id,
            m.status,
            `${definition(m.from)} -> ${definition(m.to)}`,
            m.created_at,
          ])
        )
      )
    })

  migrations
    .command("get")
    .description("Show a field migration")
    .argument("<migration>", "migration ID (mig_...)")
    .option("--wait", "wait until it finishes", false)
    .action(async (id: string, options: { wait: boolean }) => {
      const ctx = context()
      const migration = await unwrap(ctx.api.migrations.get(id))
      if (options.wait) finish(ctx, await waitFor(ctx, migration))
      else printResult(ctx, migration, () => describe(migration))
    })

  migrations
    .command("cancel")
    .description("Cancel a pending or running field migration")
    .argument("<migration>", "migration ID (mig_...)")
    .action(async (id: string) => {
      const ctx = context()
      const migration = await unwrap(
        ctx.api.migrations.cancel(id, ctx.writeOptions())
      )
      printResult(ctx, migration, () =>
        migration.status === "cancelled"
          ? `Cancelled ${migration.id}`
          : `Cancelling ${migration.id}; it stops and rolls back at its next batch`
      )
    })
}
