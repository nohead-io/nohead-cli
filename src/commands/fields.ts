import type { Command } from "commander"

import type { Field, FieldCreate, FieldUpdate } from "@nohead/sdk"
import type { CommandContext } from "../context.ts"
import { FIELD_TYPES, isFieldType, type FieldType } from "../field-types.ts"
import { unwrap } from "../errors.ts"
import { toFieldKey, usageError } from "../input.ts"
import { printResult, table } from "../output.ts"

/** Accepts the spec's dashed spelling too: rich-text -> rich_text. */
export function fieldType(value: string): FieldType {
  const type = value.replace(/-/g, "_")
  if (!isFieldType(type)) {
    throw usageError(
      `Unknown field type ${JSON.stringify(value)}. Use one of: ${FIELD_TYPES.join(", ")}`
    )
  }
  return type
}

function number(value: string, flag: string): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw usageError(`${flag} must be a number`)
  return parsed
}

export interface ConfigOptions {
  searchable?: boolean
  filterable?: boolean
  sortable?: boolean
  options?: string
  target?: string
  maxLength?: string
  min?: string
  max?: string
  description?: string
  includeTime?: boolean
  timeZone?: string
  /** false: plain text (--no-format). */
  format?: string | false
  unique?: boolean
}

/** Type-specific configuration from flags; relation targets resolve slugs to IDs. */
export async function configuration(
  ctx: CommandContext,
  options: ConfigOptions
): Promise<Record<string, unknown>> {
  const config: Record<string, unknown> = {}
  if (options.options !== undefined)
    config.options = options.options
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean)
  if (options.maxLength !== undefined)
    config.max_length = number(options.maxLength, "--max-length")
  if (options.min !== undefined) config.min = number(options.min, "--min")
  if (options.max !== undefined) config.max = number(options.max, "--max")
  if (options.description !== undefined)
    config.description = options.description
  if (options.includeTime !== undefined)
    config.include_time = options.includeTime
  if (options.timeZone !== undefined) config.time_zone = options.timeZone
  if (options.format !== undefined) config.format = options.format
  if (options.unique !== undefined) config.unique = options.unique
  for (const flag of ["searchable", "filterable", "sortable"] as const)
    if (options[flag] !== undefined) config[flag] = options[flag]
  if (options.target !== undefined) {
    const target = await unwrap(ctx.api.collections.get(options.target))
    config.target_collection_id = target.id
  }
  return config
}

/**
 * A field's configuration with options from flags on top. A date without its
 * time has no time zone either; a format sets its own lengths.
 */
export function mergeConfiguration(
  current: Record<string, unknown>,
  changes: Record<string, unknown>
): Record<string, unknown> {
  const merged = { ...current, ...changes }
  if (merged.include_time === false) {
    delete merged.include_time
    delete merged.time_zone
  }
  if (merged.format === false) delete merged.format
  else if (typeof changes.format === "string") {
    delete merged.min_length
    delete merged.max_length
  }
  return merged
}

/** A field by key (active fields) or ID; deleted fields only when asked. */
export async function resolveField(
  ctx: CommandContext,
  collection: string,
  ref: string,
  deleted = false
): Promise<Field> {
  const page = await unwrap(
    ctx.api.fields.list(collection, { limit: 100, deleted })
  )
  const field = page.data.find((f) => f.id === ref || f.key === ref)
  if (!field)
    throw usageError(
      `No ${deleted ? "deleted " : ""}field ${JSON.stringify(ref)} in ${collection}`
    )
  return field
}

export function withConfigFlags(command: Command): Command {
  return command
    .option("--options <list>", "enum options, comma-separated")
    .option("--target <collection>", "relation target collection (slug or ID)")
    .option("--max-length <n>", "maximum length for plain text fields")
    .option("--min <n>", "minimum for number fields")
    .option("--max <n>", "maximum for number fields")
    .option("--description <text>", "help text shown to editors")
    .option("--include-time", "date fields: a date and a time, not a day")
    .option("--no-include-time", "date fields: a day, with no time")
    .option(
      "--time-zone <zone>",
      "date fields with a time: the IANA zone values are written in"
    )
    .option("--format <format>", "text fields: slug, url or email")
    .option("--no-format", "text fields: plain text")
    .option("--unique", "no two records share a value (text, integer)")
    .option("--no-unique", "let records share a value")
    .option("--searchable", "match search words in this field")
    .option("--no-searchable", "leave this field out of search matching")
    .option("--filterable", "allow filter[<field>] in search")
    .option("--no-filterable", "disallow filtering in search")
    .option("--sortable", "allow sorting search results by this field")
    .option("--no-sortable", "disallow sorting search results")
}

export function registerFields(
  program: Command,
  context: () => CommandContext
) {
  const fields = program
    .command("fields")
    .description("Manage a collection's fields")

  fields
    .command("list")
    .description("List fields")
    .argument("<collection>", "collection slug or ID")
    .option("--deleted", "list deleted fields instead", false)
    .action(async (collection: string, options: { deleted: boolean }) => {
      const ctx = context()
      const page = await unwrap(
        ctx.api.fields.list(collection, {
          limit: 100,
          deleted: options.deleted,
        })
      )
      printResult(ctx, page, () =>
        table(
          ["API KEY", "NAME", "TYPE", "RULES", "ID"],
          page.data.map((f) => [
            f.key,
            f.name,
            f.type,
            [f.required && "required", f.multiple && "multiple"]
              .filter(Boolean)
              .join(", "),
            f.id,
          ])
        )
      )
    })

  withConfigFlags(
    fields
      .command("add")
      .description(
        "Add a field, e.g. nohead fields add posts title --type text --required"
      )
      .argument("<collection>", "collection slug or ID")
      .argument(
        "<name>",
        "field name; the key is derived from it unless --key is given"
      )
      .requiredOption("--type <type>", `one of: ${FIELD_TYPES.join(", ")}`)
      .option("--key <key>", "field key (default: snake_case of the name)")
      .option("--required", "every record must have a value", false)
      .option("--multiple", "store a list of values", false)
  ).action(
    async (
      collection: string,
      name: string,
      options: ConfigOptions & {
        type: string
        key?: string
        required: boolean
        multiple: boolean
      }
    ) => {
      const ctx = context()
      const result = await unwrap(
        ctx.api.fields.create(
          collection,
          {
            name,
            key: options.key ?? toFieldKey(name),
            type: fieldType(options.type),
            required: options.required,
            multiple: options.multiple,
            configuration: mergeConfiguration(
              {},
              await configuration(ctx, options)
            ),
            // Any type's options; the API checks them against the type.
          } as FieldCreate,
          ctx.writeOptions()
        )
      )
      printResult(
        ctx,
        result,
        () => `Added field ${result.key} (${result.type}) to ${collection}`
      )
    }
  )

  withConfigFlags(
    fields
      .command("update")
      .description(
        "Update a field's settings (type, multiple and a date's time: nohead fields migrate)"
      )
      .argument("<collection>", "collection slug or ID")
      .argument("<field>", "field key or ID")
      .option("--name <name>", "new display name")
      .option(
        "--key <key>",
        "new key (the old one keeps working as an alias for 6 months)"
      )
      .option("--required", "make the field required")
      .option("--optional", "make the field optional")
  ).action(
    async (
      collection: string,
      ref: string,
      options: ConfigOptions & {
        name?: string
        key?: string
        required?: boolean
        optional?: boolean
      }
    ) => {
      const ctx = context()
      if (options.required && options.optional)
        throw usageError("Pass either --required or --optional, not both")

      const field = await resolveField(ctx, collection, ref)
      const config = await configuration(ctx, options)
      const body: FieldUpdate = {}
      if (options.name) body.name = options.name
      if (options.key) body.key = options.key
      if (options.required) body.required = true
      if (options.optional) body.required = false
      // The API replaces configuration wholesale; merge so unrelated options survive.
      if (Object.keys(config).length > 0)
        body.configuration = mergeConfiguration(field.configuration, config)
      if (Object.keys(body).length === 0) throw usageError("Nothing to update")

      const result = await unwrap(
        ctx.api.fields.update(field.id, body, ctx.writeOptions())
      )
      printResult(ctx, result, () => `Updated field ${result.key}`)
    }
  )

  fields
    .command("delete")
    .description("Delete a field (values are kept and come back on restore)")
    .argument("<collection>", "collection slug or ID")
    .argument("<field>", "field key or ID")
    .action(async (collection: string, ref: string) => {
      const ctx = context()
      const field = await resolveField(ctx, collection, ref)
      const result = await unwrap(
        ctx.api.fields.delete(field.id, ctx.writeOptions())
      )
      printResult(
        ctx,
        result,
        () =>
          `Deleted field ${result.key}. Restore it with: nohead fields restore ${collection} ${result.id}`
      )
    })

  fields
    .command("restore")
    .description("Restore a deleted field")
    .argument("<collection>", "collection slug or ID")
    .argument("<field>", "deleted field key or ID")
    .action(async (collection: string, ref: string) => {
      const ctx = context()
      const field = await resolveField(ctx, collection, ref, true)
      const result = await unwrap(
        ctx.api.fields.restore(field.id, ctx.writeOptions())
      )
      printResult(ctx, result, () => `Restored field ${result.key}`)
    })
}
