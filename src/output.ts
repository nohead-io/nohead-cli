import type { CommandContext } from "./context.ts"
import type { ErrorBody } from "./errors.ts"

/**
 * Text for a terminal: content comes from the API (filenames, record values),
 * and escape sequences in it could rewrite the screen, the title or the
 * clipboard. Keeps newlines and tabs. (--json escapes them already.)
 */
function forTerminal(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
}

/**
 * JSON or YAML text with DEL and the C1 controls (U+007F to U+009F) escaped
 * as \u00XX. JSON.stringify and yaml escape only C0, and a terminal may act
 * on an 8-bit CSI or OSC (clear the screen, set the title) read from API
 * content. Both formats carry these characters only inside quoted strings
 * (yaml double-quotes any string with a control character), where \u00XX
 * means the same character.
 */
export function escapeC1(text: string): string {
  return text.replace(
    /[\u007f-\u009f]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`
  )
}

/** JSON for output, files included: C1-escaped (escapeC1). */
export function toJson(value: unknown, indent?: number): string {
  return escapeC1(JSON.stringify(value, null, indent))
}

/** JSON Lines: one value per line, each line ended. */
export function toJsonLines(values: unknown[]): string {
  return values.map((value) => `${toJson(value)}\n`).join("")
}

/**
 * Successful results go to stdout; everything else goes to stderr. With --json,
 * stdout carries exactly one JSON document so agents can parse it reliably.
 */
export function printResult(
  { runtime, options }: CommandContext,
  data: unknown,
  human: () => string
) {
  runtime.stdout(
    options.json ? `${toJson(data, 2)}\n` : `${forTerminal(human())}\n`
  )
}

/** Progress and summaries for humans; never mixed into stdout. */
export function printNotice({ runtime }: CommandContext, message: string) {
  runtime.stderr(`${forTerminal(message)}\n`)
}

export function printError(
  runtime: CommandContext["runtime"],
  json: boolean,
  error: ErrorBody
) {
  if (json) {
    runtime.stderr(`${toJson({ error }, 2)}\n`)
    return
  }

  const lines = [`Error: ${error.message}`]
  for (const detail of error.details ?? []) {
    lines.push(
      `  - ${detail.field ? `${detail.field}: ` : ""}${detail.message}`
    )
  }
  if (error.request_id) lines.push(`Request ID: ${error.request_id}`)
  runtime.stderr(`${forTerminal(lines.join("\n"))}\n`)
}

/** A compact, human-readable value for tables and diffs. */
export function formatValue(value: unknown, max = 60): string {
  if (value === null || value === undefined) return "—"
  const text = typeof value === "string" ? value : JSON.stringify(value)
  const oneLine = text.replace(/\s+/g, " ")
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine
}

/** A plain text table with aligned columns. */
export function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return "(none)"
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => (row[i] ?? "").length))
  )
  const line = (cells: string[]) =>
    cells
      .map((cell, i) =>
        i === cells.length - 1 ? cell : cell.padEnd(widths[i])
      )
      .join("  ")
      .trimEnd()
  return [
    line(headers),
    line(widths.map((w) => "-".repeat(w))),
    ...rows.map(line),
  ].join("\n")
}

/** "key: value" lines for a single object. */
export function details(entries: [string, unknown][]): string {
  const width = Math.max(...entries.map(([key]) => key.length))
  return entries
    .map(
      ([key, value]) =>
        `${`${key}:`.padEnd(width + 1)} ${formatValue(value, 200)}`
    )
    .join("\n")
}
