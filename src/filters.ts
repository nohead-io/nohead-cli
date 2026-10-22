import type { FilterOperators, RecordFilter } from "@nohead/sdk"

import { usageError } from "./input.ts"

type Operators = FilterOperators<string>
type FilterOperator = keyof Operators
type Parsed =
  | [string, "eq" | "ne" | "gt" | "gte" | "lt" | "lte", string]
  | [string, "in", string[]]
  | [string, "exists", boolean]

const SYMBOLS: Record<string, Exclude<FilterOperator, "in" | "exists">> = {
  "=": "eq",
  "!=": "ne",
  ">": "gt",
  ">=": "gte",
  "<": "lt",
  "<=": "lte",
}

const COMPARISON = /^([a-z][a-z0-9_]*)\s*(>=|<=|!=|>|<|=)(.*)$/s
const LIST = /^([a-z][a-z0-9_]*)\s+in\s+(.*)$/s
const EXISTS = /^([a-z][a-z0-9_]*)\s+(!?)exists$/

/**
 * `--filter` expressions as the API's filters: `price<50`,
 * `released>=today`, `title!=Untitled`, `category in shoes,bags` (`\,` is a
 * comma inside a value, `\\` a backslash), `cover exists`, `cover !exists`,
 * and `key=value`. Several on one key combine (`price>=10 --filter price<50`).
 */
export function parseFilters(expressions: string[] = []): RecordFilter {
  const filters: Record<string, string | Operators> = {}
  for (const expression of expressions) {
    const [key, operator, value] = parseFilter(expression)
    const current = filters[key]
    if (current === undefined && operator === "eq") {
      filters[key] = value
      continue
    }
    const operators: Operators =
      typeof current === "string" ? { eq: current } : { ...current }
    if (operators[operator] !== undefined)
      throw usageError(`--filter gives ${key} ${operator} twice`)
    Object.assign(operators, { [operator]: value })
    filters[key] = operators
  }
  return filters
}

/** "a,b\\, c" as ["a", "b, c"]: `\,` is a comma, `\\` a backslash. */
function splitList(list: string): string[] {
  const items = [""]
  for (let i = 0; i < list.length; i++) {
    const char = list[i]
    if (char === "\\" && i + 1 < list.length)
      items[items.length - 1] += list[++i]
    else if (char === ",") items.push("")
    else items[items.length - 1] += char
  }
  return items
}

function parseFilter(expression: string): Parsed {
  const exists = expression.match(EXISTS)
  if (exists) return [exists[1], "exists", !exists[2]]
  const list = expression.match(LIST)
  if (list) return [list[1], "in", splitList(list[2])]
  const comparison = expression.match(COMPARISON)
  if (comparison) return [comparison[1], SYMBOLS[comparison[2]], comparison[3]]
  throw usageError(
    `--filter expects key=value, key<value (or >, >=, <=, !=), "key in a,b" or "key exists", got ${JSON.stringify(expression)}`
  )
}
