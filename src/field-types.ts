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

const absent = (value: unknown) =>
  value === undefined || value === null || value === ""

/**
 * The change that turns a field's options into `next`, as the API merges it
 * onto them: each option that differs, and null for each one `next` leaves
 * out, which removes it. Unchanged options aren't sent, so a change made
 * meanwhile (the web app, another run) to an option this one doesn't touch
 * stays. A migration merges the same way, onto the options that carry over
 * to its target.
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
