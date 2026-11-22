import { parse, stringify } from "yaml"

import type { Collection } from "@nohead/sdk"
import { isFieldType, type FieldType } from "../field-types.ts"
import { isObject, usageError } from "../input.ts"
import { escapeC1 } from "../output.ts"

/**
 * The portable schema file, e.g. nohead.schema.yaml:
 *
 *   collections:
 *     posts:
 *       fields:
 *         title: { type: text, required: true }
 *         author: { type: relation, collection: authors }
 *         body: { type: long_text, search: { returned: false } }
 *
 * Collections are keyed by slug and fields by API key. Type options are
 * flattened (`options`, `max_length`, ...), but for the search settings,
 * grouped under `search`; a relation's target is its collection's slug.
 * Names default to the humanized key and are written only when they differ.
 */
export interface FieldSpec {
  key: string
  name: string
  type: FieldType
  required: boolean
  multiple: boolean
  /** Type options, with the relation target as a collection slug (`collection`). */
  options: Record<string, unknown>
  /**
   * The field's previous API key (`renamed_from` in the file): pushing renames
   * that field instead of adding a new one. Only read, never written.
   */
  renamed_from?: string
}

export interface CollectionSpec {
  slug: string
  name: string
  description: string | null
  /** Whether search tokens find its published records (`public_search`). */
  public_search: boolean
  fields: FieldSpec[]
}

/** The `search` group's settings, in the file's order. */
const SEARCH_KEYS = ["searchable", "filterable", "sortable", "returned"]

/**
 * The search settings a relation can list fields of its target collection
 * in: by key in the file, by ID in the API.
 */
export const RELATED_LISTS = ["searchable", "returned"] as const

/** Types with no words to search: `searchable` can only be false. */
const UNSEARCHABLE = new Set(["asset", "boolean", "date"])

const ASSET_PARTS =
  "image_url, dimensions, alt, file_url, filename, content_type"

/**
 * Where each old top-level search option went: a relation's
 * `searched` first, as its `searchable: true` only took effect with one.
 */
const MOVED: Record<string, string> = {
  searched: "searchable",
  expanded: "returned",
  included: "returned",
  searchable: "searchable",
  filterable: "filterable",
  sortable: "sortable",
}

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string")

/** An options group's `search` settings, or none. */
export const searchOf = (
  options: Record<string, unknown>
): Record<string, unknown> => (isObject(options.search) ? options.search : {})

const OPTION_KEYS = [
  "description",
  "min_length",
  "max_length",
  "min",
  "max",
  "options",
  "include_time",
  "time_zone",
  "format",
  "unique",
  "accepted_types",
  "collection",
  "search",
]
const FIELD_KEYS = [
  "type",
  "name",
  "required",
  "multiple",
  "renamed_from",
  ...OPTION_KEYS,
]
const COLLECTION_KEYS = ["name", "description", "public_search", "fields"]
const SLUG = /^[a-z][a-z0-9_-]{0,62}$/
const FIELD_KEY = /^[a-z][a-z0-9_]{0,62}$/

/**
 * Options without what another option or a default implies, so a file that
 * says it matches one that doesn't: a slug is always unique, and every field
 * is returned in search hits by default (`returned: true`). The search
 * settings come last, in the file's order, and an empty group not at all.
 */
function withoutImplied(
  options: Record<string, unknown>
): Record<string, unknown> {
  const { search, ...rest } = options
  if (rest.unique === true && rest.format === "slug") delete rest.unique
  if (!isObject(search)) return rest
  const settings = SEARCH_KEYS.filter(
    (key) =>
      search[key] !== undefined && !(key === "returned" && search[key] === true)
  )
  return settings.length > 0
    ? {
        ...rest,
        search: Object.fromEntries(settings.map((key) => [key, search[key]])),
      }
    : rest
}

/** "lead_author" / "blog-posts" -> "Lead Author" / "Blog Posts". */
export function humanize(key: string): string {
  return key
    .split(/[_-]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ")
}

/**
 * Collections as specs; relation targets become slugs (or stay IDs if
 * unknown), and the related fields a relation's searches match and its
 * search hits return (`search.searchable`, `search.returned`) keys (a field
 * deleted since is left out, as search skips it).
 */
export function fromCollections(collections: Collection[]): CollectionSpec[] {
  const slugs = new Map(collections.map((c) => [c.id, c.slug]))
  const keys = new Map(
    collections.flatMap((c) => c.fields.map((f) => [f.id, f.key] as const))
  )
  return collections.map((collection) => ({
    slug: collection.slug,
    name: collection.name,
    description: collection.description,
    public_search: collection.public_search,
    fields: collection.fields.map((field) => {
      const { target_collection_id: target, ...rest } =
        field.configuration as Record<string, unknown>
      if (field.type === "relation" && isObject(rest.search)) {
        const search = { ...rest.search }
        for (const setting of RELATED_LISTS) {
          const listed = search[setting]
          if (Array.isArray(listed))
            search[setting] = listed.flatMap((id: unknown) =>
              keys.has(String(id)) ? [keys.get(String(id))] : []
            )
        }
        rest.search = search
      }
      return {
        key: field.key,
        name: field.name,
        type: field.type,
        required: field.required,
        multiple: field.multiple,
        options: withoutImplied({
          ...rest,
          ...(typeof target === "string"
            ? { collection: slugs.get(target) ?? target }
            : {}),
        }),
      }
    }),
  }))
}

export function toYaml(collections: CollectionSpec[]): string {
  const document = {
    collections: Object.fromEntries(
      collections.map((collection) => [
        collection.slug,
        {
          ...(collection.name !== humanize(collection.slug)
            ? { name: collection.name }
            : {}),
          ...(collection.description
            ? { description: collection.description }
            : {}),
          ...(collection.public_search ? { public_search: true } : {}),
          fields: Object.fromEntries(
            collection.fields.map((field) => [
              field.key,
              {
                type: field.type,
                ...(field.name !== humanize(field.key)
                  ? { name: field.name }
                  : {}),
                ...(field.required ? { required: true } : {}),
                ...(field.multiple ? { multiple: true } : {}),
                ...field.options,
              },
            ])
          ),
        },
      ])
    ),
  }
  return [
    "# Nohead schema: nohead schema diff | push. Collections are keyed by slug,",
    "# fields by API key (renaming a key is a new field). Field order is kept.",
    escapeC1(stringify(document, { lineWidth: 0 })),
  ].join("\n")
}

function unknownKeys(
  value: Record<string, unknown>,
  allowed: string[],
  where: string
) {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key))
  if (extra.length > 0)
    throw usageError(
      `${where}: unknown key${extra.length > 1 ? "s" : ""} ${extra.join(", ")} (allowed: ${allowed.join(", ")})`
    )
}

/** A value as the file would write it inline, for messages: `[a, b]`, `true`. */
const flow = (value: unknown) =>
  Array.isArray(value) ? `[${value.join(", ")}]` : String(value)

/**
 * Checks a field's `search` group against its type: true or false, but a
 * relation lists related field keys (`searchable`: false or a list,
 * `returned`: true, false or a list), an asset's `returned` its parts, and
 * types with no words are never searchable.
 */
function checkSearch(
  field: Record<string, unknown>,
  type: FieldType,
  at: string
) {
  if (field.search === undefined) return
  const search = field.search
  if (!isObject(search))
    throw usageError(
      `${at}.search must be a mapping (${SEARCH_KEYS.join(", ")})`
    )
  unknownKeys(search, SEARCH_KEYS, `${at}.search`)
  const where = (setting: string) => `${at}.search.${setting}`
  for (const setting of ["filterable", "sortable"])
    if (search[setting] !== undefined && typeof search[setting] !== "boolean")
      throw usageError(`${where(setting)}: true or false`)

  const { searchable, returned } = search
  if (searchable !== undefined) {
    if (type === "relation") {
      if (searchable === true)
        throw usageError(
          `${where("searchable")}: a relation holds IDs, no words: list the related collection's field keys searches match (searchable: [name])`
        )
      if (searchable !== false && !isStringList(searchable))
        throw usageError(
          `${where("searchable")}: false or a list (the related collection's field keys)`
        )
    } else if (UNSEARCHABLE.has(type)) {
      if (searchable !== false)
        throw usageError(
          `${where("searchable")}: ${type} fields hold no words to search; only false`
        )
    } else if (typeof searchable !== "boolean")
      throw usageError(`${where("searchable")}: true or false`)
  }
  if (
    returned !== undefined &&
    typeof returned !== "boolean" &&
    !((type === "asset" || type === "relation") && isStringList(returned))
  )
    throw usageError(
      type === "asset" || type === "relation"
        ? `${where("returned")}: true, false or a list (${type === "asset" ? ASSET_PARTS : "the related collection's field keys"})`
        : `${where("returned")}: true or false`
    )
}

export function fromYaml(text: string, source: string): CollectionSpec[] {
  let document: unknown
  try {
    document = parse(text)
  } catch (error) {
    throw usageError(
      `${source} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (!isObject(document) || !isObject(document.collections))
    throw usageError(`${source} must have a "collections" mapping`)

  return Object.entries(document.collections).map(([slug, raw]) => {
    const where = `${source}: collections.${slug}`
    if (!SLUG.test(slug))
      throw usageError(
        `${where}: slugs are lowercase letters, digits, - and _ and start with a letter`
      )
    const collection = raw ?? {}
    if (!isObject(collection)) throw usageError(`${where} must be a mapping`)
    if ("search" in collection)
      throw usageError(
        `${where}.search: no longer a setting (API keys search every collection they can read); delete it`
      )
    unknownKeys(collection, COLLECTION_KEYS, where)
    if (
      collection.public_search !== undefined &&
      typeof collection.public_search !== "boolean"
    )
      throw usageError(`${where}.public_search must be true or false`)
    const fields = collection.fields ?? {}
    if (!isObject(fields)) throw usageError(`${where}.fields must be a mapping`)
    const renamed = new Set<string>()

    return {
      slug,
      name:
        typeof collection.name === "string" ? collection.name : humanize(slug),
      description:
        typeof collection.description === "string"
          ? collection.description
          : null,
      public_search: collection.public_search === true,
      fields: Object.entries(fields).map(([fieldKey, rawField]) => {
        const at = `${where}.fields.${fieldKey}`
        if (!FIELD_KEY.test(fieldKey))
          throw usageError(
            `${at}: API keys are snake_case and start with a letter`
          )
        const field =
          typeof rawField === "string" ? { type: rawField } : rawField
        if (!isObject(field))
          throw usageError(`${at} must be a mapping or a type name`)
        for (const key of Object.keys(MOVED))
          if (key in field)
            throw usageError(
              `${at}: ${key} goes under search:${MOVED[key] === key ? "" : ` as ${MOVED[key]}`} (search: { ${MOVED[key]}: ${flow(field[key])} })`
            )
        unknownKeys(field, FIELD_KEYS, at)
        const type = String(field.type).replace(/-/g, "_")
        if (!isFieldType(type))
          throw usageError(`${at}: unknown type ${JSON.stringify(field.type)}`)
        if (type === "relation" && typeof field.collection !== "string")
          throw usageError(
            `${at}: relation fields need "collection" (the target collection's slug)`
          )
        checkSearch(field, type, at)

        const renamedFrom = field.renamed_from
        if (
          renamedFrom !== undefined &&
          (typeof renamedFrom !== "string" ||
            !FIELD_KEY.test(renamedFrom) ||
            renamedFrom === fieldKey)
        )
          throw usageError(
            `${at}: renamed_from is the field's previous API key`
          )
        if (typeof renamedFrom === "string" && renamedFrom in fields)
          throw usageError(
            `${at}: renamed_from ${renamedFrom}, but ${renamedFrom} is also in the file`
          )
        if (typeof renamedFrom === "string") {
          if (renamed.has(renamedFrom))
            throw usageError(
              `${at}: another field is already renamed_from ${renamedFrom}`
            )
          renamed.add(renamedFrom)
        }

        return {
          key: fieldKey,
          ...(typeof renamedFrom === "string"
            ? { renamed_from: renamedFrom }
            : {}),
          name:
            typeof field.name === "string" ? field.name : humanize(fieldKey),
          type,
          required: field.required === true,
          multiple: field.multiple === true,
          options: withoutImplied(
            Object.fromEntries(
              OPTION_KEYS.filter((key) => key in field).map((key) => [
                key,
                field[key],
              ])
            )
          ),
        }
      }),
    }
  })
}
