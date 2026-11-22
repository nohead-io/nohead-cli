import { Option, type Command } from "commander"

import type { Collection, Field, FieldCreate, FieldUpdate } from "@nohead/sdk"
import type { CommandContext } from "../context.ts"
import {
  configurationChange,
  FIELD_TYPES,
  isFieldType,
  type FieldType,
} from "../field-types.ts"
import { unwrap, unwrapFind } from "../errors.ts"
import { isObject, toFieldKey, usageError } from "../input.ts"
import { searchOf } from "../schema/format.ts"
import { printResult, table } from "../output.ts"
import { pageQuery, printList, withPaging, type PageOptions } from "../pages.ts"
import { apiOptions, fieldIdsOf } from "./schema.ts"

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
  /** A new type (add, migrate). */
  type?: FieldType
  /** true, false, or a relation's related field keys, comma-separated. */
  searchable?: boolean | string
  filterable?: boolean
  sortable?: boolean
  /** true, false, or an asset's parts or a relation's related field keys. */
  returned?: boolean | string
  options?: string
  target?: string
  minLength?: number
  maxLength?: number
  acceptedTypes?: string
  min?: number
  max?: number
  description?: string
  includeTime?: boolean
  timeZone?: string
  /** false: plain text (--no-format). */
  format?: string | false
  unique?: boolean
}

const list = (value: string) =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)

/**
 * Type-specific configuration from flags for `field` (its key, and its
 * current configuration when it exists): relation targets resolve slugs to
 * IDs, and the related fields a relation's searches match and its search
 * hits return keys to IDs. The search settings go in `search`, only those
 * given: the API merges them onto the field's.
 */
export async function configuration(
  ctx: CommandContext,
  options: ConfigOptions,
  field: {
    key: string
    type?: string
    configuration?: Record<string, unknown>
  }
): Promise<Record<string, unknown>> {
  const config: Record<string, unknown> = {}
  if (options.options !== undefined) config.options = list(options.options)
  if (options.minLength !== undefined) config.min_length = options.minLength
  if (options.maxLength !== undefined) config.max_length = options.maxLength
  if (options.acceptedTypes !== undefined)
    config.accepted_types = list(options.acceptedTypes)
  if (options.min !== undefined) config.min = options.min
  if (options.max !== undefined) config.max = options.max
  if (options.description !== undefined)
    config.description = options.description
  if (options.includeTime !== undefined)
    config.include_time = options.includeTime
  if (options.timeZone !== undefined) config.time_zone = options.timeZone
  if (options.format !== undefined) config.format = options.format
  if (options.unique !== undefined) config.unique = options.unique
  const type = options.type ?? field.type
  const search: Record<string, unknown> = {}
  for (const flag of [
    "searchable",
    "filterable",
    "sortable",
    "returned",
  ] as const) {
    const value = options[flag]
    if (value === undefined) continue
    if (typeof value !== "string") search[flag] = value
    else if (flag === "returned" && (type === "asset" || type === "relation"))
      search[flag] = list(value)
    else if (flag === "searchable" && type === "relation")
      search[flag] = list(value)
    else
      throw usageError(
        `--${flag} takes a list only for ${flag === "returned" ? "asset and relation" : "relation"} fields (got ${JSON.stringify(value)})`
      )
  }
  if (
    type === "relation" &&
    (search.searchable === true ||
      (Array.isArray(search.searchable) && search.searchable.length === 0))
  )
    throw usageError(
      "A relation holds IDs, no words: pass --searchable with the related collection's field keys searches match"
    )
  let target: Collection | undefined
  if (options.target !== undefined) {
    target = await unwrap(ctx.api.collections.get(options.target))
    config.target_collection_id = target.id
  }
  // A relation's related fields by key become IDs, as schema push sends
  // them; an asset's parts stay as they are.
  if (
    type === "relation" &&
    (Array.isArray(search.searchable) || Array.isArray(search.returned))
  ) {
    const current = field.configuration?.target_collection_id
    if (!target && typeof current === "string")
      target = await unwrap(ctx.api.collections.get(current))
    if (!target)
      throw usageError(
        `Field ${field.key} has no target collection: pass --target`
      )
    Object.assign(
      config,
      apiOptions(
        { search },
        new Map(),
        field.key,
        fieldIdsOf([target]),
        target.slug
      )
    )
  } else if (Object.keys(search).length > 0) config.search = search
  return config
}

/**
 * A field's configuration with options from flags on top, search settings
 * too. A date without its time has no time zone either; a format sets its
 * own lengths.
 */
export function mergeConfiguration(
  current: Record<string, unknown>,
  changes: Record<string, unknown>
): Record<string, unknown> {
  const merged = { ...current, ...changes }
  // The search settings given join the field's, as the API merges them.
  if (isObject(changes.search))
    merged.search = { ...searchOf(current), ...changes.search }
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
  const field = await unwrapFind(
    ctx.api.fields.list(collection, { limit: 100, deleted }),
    (f) => f.id === ref || f.key === ref
  )
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
    .option(
      "--min-length <n>",
      "minimum length for text, long text and rich text fields",
      (value) => number(value, "--min-length")
    )
    .option(
      "--max-length <n>",
      "maximum length for text, long text and rich text fields",
      (value) => number(value, "--max-length")
    )
    .option(
      "--accepted-types <list>",
      "asset fields: MIME types or type/* wildcards new values must have, comma-separated"
    )
    .option("--min <n>", "minimum for number fields", (value) =>
      number(value, "--min")
    )
    .option("--max <n>", "maximum for number fields", (value) =>
      number(value, "--max")
    )
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
    .option(
      "--searchable [fields]",
      "searches match this field's words; relation fields: the related collection's field keys to match, comma-separated"
    )
    .option("--no-searchable", "searches don't match this field's words")
    .option("--filterable", "searches can filter on this field")
    .option("--no-filterable", "searches can't filter on this field")
    .option("--sortable", "searches can sort on this field")
    .option("--no-sortable", "searches can't sort on this field")
    .option(
      "--returned [list]",
      "public search hits return this field; or, comma-separated, an asset's parts (image_url, dimensions, alt, file_url, filename, content_type) or the related collection's field keys"
    )
    .option("--no-returned", "public search hits leave this field out")
}

export function registerFields(
  program: Command,
  context: () => CommandContext
) {
  const fields = program
    .command("fields")
    .description("Manage a collection's fields")

  withPaging(
    fields
      .command("list")
      .description("List fields")
      .argument("<collection>", "collection slug or ID")
      .option("--deleted", "list deleted fields instead", false),
    "field"
  ).action(
    async (collection: string, options: PageOptions & { deleted: boolean }) => {
      const ctx = context()
      const query = { ...pageQuery(options), deleted: options.deleted }
      await printList(
        ctx,
        options.all,
        () => ctx.api.fields.list(collection, query),
        (items) =>
          table(
            ["API KEY", "NAME", "TYPE", "RULES", "ID"],
            items.map((f) => [
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
    }
  )

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
      .requiredOption(
        "--type <type>",
        `one of: ${FIELD_TYPES.join(", ")}`,
        fieldType
      )
      .option("--key <key>", "field key (default: snake_case of the name)")
      .option("--required", "every record must have a value", false)
      .option("--multiple", "store a list of values", false)
  ).action(
    async (
      collection: string,
      name: string,
      options: ConfigOptions & {
        type: FieldType
        key?: string
        required: boolean
        multiple: boolean
      }
    ) => {
      const ctx = context()
      const key = options.key ?? toFieldKey(name)
      const result = await unwrap(
        ctx.api.fields.create(
          collection,
          {
            name,
            key,
            type: options.type,
            required: options.required,
            multiple: options.multiple,
            configuration: mergeConfiguration(
              {},
              await configuration(ctx, options, { key })
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
      .addOption(
        new Option("--optional", "make the field optional").conflicts(
          "required"
        )
      )
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
      const field = await resolveField(ctx, collection, ref)
      const config = await configuration(ctx, options, field)
      const body: FieldUpdate = {}
      if (options.name) body.name = options.name
      if (options.key) body.key = options.key
      if (options.required) body.required = true
      if (options.optional) body.required = false
      // The API merges a change onto the field's options; send only the
      // options the flags change (null removes one), so the rest stay.
      if (Object.keys(config).length > 0)
        body.configuration = configurationChange(
          field.configuration,
          mergeConfiguration(field.configuration, config)
        )
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
