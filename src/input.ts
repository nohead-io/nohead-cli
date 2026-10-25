import slugify from "@sindresorhus/slugify"
import { Option } from "commander"

import type { Runtime } from "./context.ts"
import { CliError, ExitCode } from "./errors.ts"

export function usageError(message: string): CliError {
  return new CliError(ExitCode.Usage, { type: "invalid_request", message })
}

/**
 * --set pairs, httpie style: `title=Hello` sets a string, `views:=3` sets any
 * JSON value (numbers, booleans, null, arrays, objects).
 */
export function parseSet(pairs: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const pair of pairs) {
    const json = pair.match(/^([^=:]+):=(.*)$/s)
    if (json) {
      try {
        result[json[1]] = JSON.parse(json[2])
      } catch {
        throw usageError(
          `--set ${json[1]}:= expects JSON, got ${JSON.stringify(json[2])}`
        )
      }
      continue
    }
    const text = pair.match(/^([^=]+)=(.*)$/s)
    if (!text)
      throw usageError(
        `--set expects key=value or key:=json, got ${JSON.stringify(pair)}`
      )
    result[text[1]] = text[2]
  }
  return result
}

/** A JSON object or YAML mapping: not null, not an array. */
export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export function parseJsonObject(
  text: string,
  source: string
): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw usageError(`${source} is not valid JSON`)
  }
  if (!isObject(value)) throw usageError(`${source} must be a JSON object`)
  return value
}

export async function readSource(
  runtime: Runtime,
  path: string
): Promise<string> {
  try {
    return path === "-"
      ? await runtime.readStdin()
      : await runtime.readFile(path)
  } catch (cause) {
    throw usageError(
      `Cannot read ${path}: ${cause instanceof Error ? cause.message : String(cause)}`
    )
  }
}

/** Record data from --data, --data-file and --set (applied in that order). */
export async function readData(
  runtime: Runtime,
  options: { data?: string; dataFile?: string; set?: string[] },
  { required = true }: { required?: boolean } = {}
): Promise<Record<string, unknown>> {
  const data: Record<string, unknown> = {}
  if (options.data) Object.assign(data, parseJsonObject(options.data, "--data"))
  if (options.dataFile) {
    Object.assign(
      data,
      parseJsonObject(
        await readSource(runtime, options.dataFile),
        options.dataFile
      )
    )
  }
  Object.assign(data, parseSet(options.set ?? []))
  if (required && Object.keys(data).length === 0) {
    throw usageError(
      "Provide record data with --set key=value, --data '{...}' or --data-file <path>"
    )
  }
  return data
}

const UNITS = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }

/**
 * A time for --publish-at and the like: an ISO 8601 time with a time zone
 * (2026-10-01T09:00:00Z), an offset from now (+30m, +2h, +3d, +1w), or
 * "none" for no time (null).
 */
export function parseTime(
  value: string,
  flag: string,
  now: Date
): string | null {
  if (value === "none") return null
  const offset = /^\+(\d+)([mhdw])$/.exec(value)
  if (offset)
    return new Date(
      now.getTime() + Number(offset[1]) * UNITS[offset[2] as keyof typeof UNITS]
    ).toISOString()
  if (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(
      value
    )
  ) {
    const date = new Date(value)
    if (!Number.isNaN(date.getTime())) return date.toISOString()
  }
  throw usageError(
    `${flag} must be an ISO 8601 time with a time zone (2026-10-01T09:00:00Z), an offset (+2h, +3d), or none`
  )
}

export function positiveInteger(value: string, flag: string): number {
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1)
    throw usageError(`${flag} must be a positive integer`)
  return number
}

/** Repeatable option collector for commander. */
export function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value]
}

/**
 * "Cover Image" -> "cover_image". Letters are transliterated ("Größe" ->
 * "groesse"); a key starts with a letter and has at most 63 characters.
 */
export function toFieldKey(name: string): string {
  return slugify(name, { separator: "_", decamelize: false })
    .replace(/^[^a-z]+/, "")
    .slice(0, 63)
    .replace(/_+$/, "")
}

/** --if-revision, the revision a record or draft must be at: the SDK's ifMatch. */
export function ifRevisionOption(what: "record" | "draft"): Option {
  return new Option(
    "--if-revision <n>",
    `fail with 412 unless the ${what} is still at this revision`
  ).argParser((value) => positiveInteger(value, "--if-revision"))
}
