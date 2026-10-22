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
