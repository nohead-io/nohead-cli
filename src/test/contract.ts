// Contract helpers for the tests, which stub the API.
//
// Hand-written stubs silently drift from the real API. Build every stubbed API
// response with contractResponse() so it is validated against the documented
// response schema in openapi.json (the API's published contract), and check
// every request the code under test sends with assertRequestMatchesContract(),
// so a contract change breaks the tests that depend on the old shape in either
// direction.

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js"
import addFormats from "ajv-formats"

const CONTRACT_ID = "nohead-openapi"

type Json = Record<string, unknown>

const CONTRACT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../openapi.json"
)
const contract = JSON.parse(readFileSync(CONTRACT_PATH, "utf8")) as Json

function validator(document: Json) {
  const ajv = new Ajv2020({
    strict: false,
    allErrors: true,
    validateSchema: false,
  })
  addFormats.default(ajv)
  ajv.addSchema(document, CONTRACT_ID)
  return ajv
}

const ajv = validator(contract)

const HTTP_METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
]

function escapePointer(segment: string) {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1")
}

/** The JSON schema of a response or request body. */
function jsonSchemaOf(pointer: string) {
  return `${pointer}/content/${escapePointer("application/json")}/schema`
}

function resolve(pointer: string, document: Json = contract): unknown {
  return pointer
    .split("/")
    .slice(1)
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce<unknown>(
      (node, segment) => (node as Json | undefined)?.[segment],
      document
    )
}

interface Parameter {
  name: string
  in: "path" | "query" | "header" | "cookie"
  required?: boolean
  style?: string
  schema?: Json
}

interface Operation {
  operationId: string
  method: string
  /** The path template's segments, e.g. ["", "v1", "records", "{record_id}"]. */
  segments: string[]
  pointer: string
  /** Each parameter with the pointer to its definition. */
  parameters: { parameter: Parameter; pointer: string }[]
  /** The pointer to the JSON request body's definition, if it takes one. */
  body?: string
}

/** A $ref is followed to its definition's pointer. */
function follow(pointer: string): string {
  const ref = (resolve(pointer) as Json | undefined)?.$ref
  return typeof ref === "string" ? ref.slice(1) : pointer
}

function parametersAt(pointer: string) {
  const list = (resolve(`${pointer}/parameters`) as unknown[] | undefined) ?? []
  return list.map((_, index) => {
    const at = follow(`${pointer}/parameters/${index}`)
    return { parameter: resolve(at) as Parameter, pointer: at }
  })
}

const operations: Operation[] = Object.entries(
  contract.paths as Record<string, Json>
).flatMap(([path, item]) => {
  const pathPointer = `/paths/${escapePointer(path)}`
  const shared = parametersAt(pathPointer)
  return HTTP_METHODS.filter((method) => item[method]).map((method) => {
    const pointer = `${pathPointer}/${method}`
    const own = parametersAt(pointer)
    // An operation's parameter replaces the path's of the same name and place.
    const parameters = [
      ...shared.filter(
        ({ parameter }) =>
          !own.some(
            (o) =>
              o.parameter.name === parameter.name &&
              o.parameter.in === parameter.in
          )
      ),
      ...own,
    ]
    const body = (item[method] as Json).requestBody
      ? follow(`${pointer}/requestBody`)
      : undefined
    return {
      operationId: (item[method] as Json).operationId as string,
      method,
      segments: path.split("/"),
      pointer,
      parameters,
      body,
    }
  })
})

// The API ignores request properties it does not know, so a misspelled or
// renamed one is lost without an error. Requests are checked against a copy of
// the contract in which the object schemas they use refuse properties they do
// not list (composed ones, allOf and the like, stay as documented).
const closedContract = structuredClone(contract)

function closeObjects(node: unknown, seen = new Set<unknown>()) {
  if (typeof node !== "object" || node === null || seen.has(node)) return
  seen.add(node)
  const schema = node as Json
  if (typeof schema.$ref === "string") {
    closeObjects(resolve(schema.$ref.slice(1), closedContract), seen)
    return
  }
  if (schema.allOf || schema.anyOf || schema.oneOf) return
  if (
    schema.type === "object" &&
    schema.properties &&
    !("additionalProperties" in schema) &&
    !("unevaluatedProperties" in schema)
  ) {
    schema.additionalProperties = false
  }
  for (const child of [
    ...Object.values((schema.properties as Json | undefined) ?? {}),
    schema.items,
    schema.additionalProperties,
  ]) {
    closeObjects(child, seen)
  }
}

for (const operation of operations) {
  for (const { pointer } of operation.parameters) {
    closeObjects(resolve(`${pointer}/schema`, closedContract))
  }
  if (operation.body) {
    closeObjects(resolve(jsonSchemaOf(operation.body), closedContract))
  }
}
const requestAjv = validator(closedContract)

function findOperation(operationId: string): string {
  const operation = operations.find((o) => o.operationId === operationId)
  if (!operation) {
    throw new Error(`operationId "${operationId}" is not in openapi.json`)
  }
  return operation.pointer
}

/**
 * Ajv's messages, naming the property an `additionalProperties` error is
 * about (a renamed field reads as "must NOT have additional properties").
 */
function describeErrors(
  errors: ErrorObject[] | null | undefined,
  dataVar: string
): string {
  return (errors ?? [])
    .map((error) => {
      const extra = error.params.additionalProperty as string | undefined
      return `${dataVar}${error.instancePath} ${error.message}${extra ? ` ('${extra}')` : ""}`
    })
    .join(", ")
}

function responsePointer(operationId: string, status: number): string {
  const operation = findOperation(operationId)
  // The contract documents exact statuses, never 2XX or default.
  const pointer = `${operation}/responses/${status}`
  if (resolve(pointer) === undefined) {
    throw new Error(`${operationId} does not document a ${status} response`)
  }
  return follow(pointer)
}

/** Throws unless `body` matches the documented JSON response schema. */
export function assertMatchesContract(
  operationId: string,
  status: number,
  body: unknown
) {
  const pointer = jsonSchemaOf(responsePointer(operationId, status))
  if (resolve(pointer) === undefined) {
    throw new Error(`${operationId} ${status} has no application/json schema`)
  }

  const validate = ajv.getSchema(`${CONTRACT_ID}#${pointer}`)!
  if (!validate(body)) {
    throw new Error(
      `Stubbed ${operationId} ${status} response does not match openapi.json: ` +
        describeErrors(validate.errors, "body")
    )
  }
}

/** A JSON Response for a stubbed API call, validated against the contract. */
export function contractResponse(
  operationId: string,
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {}
) {
  const status = init.status ?? 200
  assertMatchesContract(operationId, status, body)

  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...init.headers },
  })
}

/** The documented operation for a request: the most literal matching path. */
function matchOperation(method: string, pathname: string) {
  const segments = pathname.split("/")
  const matches = operations
    .map((operation) => {
      if (operation.segments.length !== segments.length) return undefined
      const params: Record<string, string> = {}
      let literals = 0
      for (const [index, part] of operation.segments.entries()) {
        const param = part.match(/^\{(\w+)\}$/)?.[1]
        if (param && segments[index] !== "") {
          params[param] = decodeURIComponent(segments[index])
        } else if (part === segments[index]) {
          literals++
        } else {
          return undefined
        }
      }
      return { operation, params, literals }
    })
    .filter((match) => match !== undefined)
  if (matches.length === 0) {
    throw new Error(`${method} ${pathname} is not in openapi.json`)
  }

  const [best] = matches
    .filter((match) => match.operation.method === method.toLowerCase())
    .sort((a, b) => b.literals - a.literals)
  if (!best) {
    throw new Error(`openapi.json documents no ${method} for ${pathname}`)
  }
  return best
}

/** A path or query value as the type its schema documents. */
function fromString(value: string, schema: Json | undefined): unknown {
  const type = schema?.type
  if (
    (type === "integer" || type === "number") &&
    value.trim() !== "" &&
    !Number.isNaN(Number(value))
  ) {
    return Number(value)
  }
  if (type === "boolean" && (value === "true" || value === "false")) {
    return value === "true"
  }
  return value
}

/** `filter[price][lt]=50` as { price: { lt: "50" } }. */
function setDeep(target: Json, keys: string[], value: string) {
  const [key, ...rest] = keys
  if (rest.length === 0) {
    target[key] = value
  } else {
    target[key] ??= {}
    setDeep(target[key] as Json, rest, value)
  }
}

/**
 * Throws unless the request matches a documented operation: its method and
 * path, path and query parameters (`deepObject` ones such as `filter[...]`
 * included) and JSON body (`body`, parsed; omit it for a request without one).
 * Undocumented parameters and body properties are refused. Returns the
 * operationId, to check the response with assertMatchesContract().
 */
export function assertRequestMatchesContract({
  method,
  url,
  body,
}: {
  method: string
  url: string | URL
  body?: unknown
}): string {
  const { pathname, searchParams } = new URL(url, "http://localhost")
  const { operation, params } = matchOperation(method, pathname)
  const problems: string[] = []
  const check = (pointer: string, value: unknown, dataVar: string) => {
    const validate = requestAjv.getSchema(`${CONTRACT_ID}#${pointer}`)!
    if (!validate(value))
      problems.push(describeErrors(validate.errors, dataVar))
  }

  const query: Json = {}
  for (const [key, value] of searchParams) {
    const [, name, brackets] = key.match(/^([^[]*)(.*)$/)!
    const entry = operation.parameters.find(
      ({ parameter }) => parameter.in === "query" && parameter.name === name
    )
    if (!entry) {
      problems.push(`query parameter ${key} is not documented`)
    } else if (entry.parameter.style === "deepObject") {
      const keys = [...brackets.matchAll(/\[([^\]]*)\]/g)].map(([, k]) => k)
      if (keys.length === 0) {
        problems.push(`query parameter ${key} takes ${key}[<key>]=<value>`)
      } else {
        setDeep((query[name] ??= {}) as Json, keys, value)
      }
    } else if (brackets || name in query) {
      problems.push(`query parameter ${key} is not documented`)
    } else {
      query[name] = fromString(value, entry.parameter.schema)
    }
  }

  for (const { parameter, pointer } of operation.parameters) {
    if (parameter.in !== "path" && parameter.in !== "query") continue
    const value =
      parameter.in === "path" ? params[parameter.name] : query[parameter.name]
    if (value === undefined) {
      if (parameter.required) {
        problems.push(`${parameter.in} parameter ${parameter.name} is required`)
      }
      continue
    }
    check(
      `${pointer}/schema`,
      parameter.in === "path"
        ? fromString(value as string, parameter.schema)
        : value,
      `${parameter.in} parameter ${parameter.name}`
    )
  }

  const schema = operation.body ? jsonSchemaOf(operation.body) : undefined
  if (body === undefined) {
    if (operation.body && (resolve(operation.body) as Json).required) {
      problems.push("a JSON body is required")
    }
  } else if (!schema || resolve(schema) === undefined) {
    problems.push("it takes no JSON body")
  } else {
    check(schema, body, "body")
  }

  if (problems.length > 0) {
    throw new Error(
      `${method} ${pathname} (${operation.operationId}) does not match openapi.json: ${problems.join("; ")}`
    )
  }
  return operation.operationId
}
