import type { FieldType } from "@nohead/sdk"

export type { FieldType }

// Every type the API has: the Record fails to compile when one is missing.
const TYPES: Record<FieldType, true> = {
  text: true,
  long_text: true,
  rich_text: true,
  integer: true,
  decimal: true,
  date: true,
  boolean: true,
  enum: true,
  asset: true,
  relation: true,
  json: true,
}

/** The API's field types, to check and list them (the SDK has only the type). */
export const FIELD_TYPES = Object.keys(TYPES) as FieldType[]

export const isFieldType = (value: string): value is FieldType =>
  Object.hasOwn(TYPES, value)

/** The options every field type has: the only ones a type change keeps. */
export const COMMON_OPTIONS = [
  "description",
  "searchable",
  "filterable",
  "sortable",
] as const

const absent = (value: unknown) =>
  value === undefined || value === null || value === ""

/**
 * The change that turns a field's options into `next`, as the API merges it
 * onto them: each option that differs, and null for each one `next` leaves
 * out, which removes it. Unchanged options aren't sent, so a change made
 * meanwhile (the web app, another run) to an option this one doesn't touch
 * stays. `current` is what the API merges onto: the field's options, or,
 * for a type change, only its COMMON_OPTIONS.
 */
export function configurationChange(
  current: Record<string, unknown>,
  next: Record<string, unknown>
): Record<string, unknown> {
  const change: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(next))
    if (
      !absent(value) &&
      JSON.stringify(value) !== JSON.stringify(current[key])
    )
      change[key] = value
  for (const [key, value] of Object.entries(current))
    if (!absent(value) && absent(next[key])) change[key] = null
  return change
}

/** The options a field keeps through a migration to `type`. */
export function keptOptions(
  options: Record<string, unknown>,
  fromType: string,
  toType: string
): Record<string, unknown> {
  if (fromType === toType) return options
  return Object.fromEntries(
    Object.entries(options).filter(([key]) =>
      (COMMON_OPTIONS as readonly string[]).includes(key)
    )
  )
}
