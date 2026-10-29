// Requests the SDK does not make: signing in with the browser and ending a
// CLI session (/auth, outside the /v1 API), and listing the person's projects
// (an operation of the web app's that a CLI session may call too). They go
// through the runtime's fetch directly.

import type { Runtime } from "./context.ts"
import { CliError, ExitCode, networkError, type ErrorBody } from "./errors.ts"
import { isObject } from "./input.ts"
import { VERSION } from "./version.ts"

/** The API's answer, or why there was none. */
export type Answer =
  | { status: number; body: unknown; retryAfter?: number }
  | { unreachable: CliError }

/** Retry-After in seconds, given as seconds or as an HTTP date. */
function retryAfter(header: string | null, now: Date): number | undefined {
  if (!header) return undefined
  const value = Number(header)
  if (header.trim() !== "" && Number.isFinite(value)) return value
  const date = Date.parse(header)
  return Number.isNaN(date) ? undefined : (date - now.getTime()) / 1000
}

/** One request, without retries; a body is sent as JSON. */
export async function send(
  runtime: Runtime,
  apiUrl: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  { token, body }: { token?: string; body?: unknown } = {}
): Promise<Answer> {
  let response: Response
  try {
    response = await runtime.fetch(
      new Request(`${apiUrl.replace(/\/+$/, "")}${path}`, {
        method,
        headers: {
          Accept: "application/json",
          "Nohead-Client": `cli/${VERSION}`,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      })
    )
  } catch (error) {
    return { unreachable: networkError(error) }
  }
  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    parsed = undefined
  }
  return {
    status: response.status,
    body: parsed,
    retryAfter: retryAfter(response.headers.get("Retry-After"), runtime.now()),
  }
}

/** The API's error envelope as the CLI reports it (as errors.ts does). */
export function apiError(status: number, body: unknown): CliError {
  const error = isObject(body) ? body.error : undefined
  if (!isObject(error) || typeof error.type !== "string")
    return new CliError(ExitCode.ApiError, {
      type: "internal_error",
      message: `Unexpected API response (HTTP ${status})`,
    })
  const details = Array.isArray(error.details)
    ? (error.details as NonNullable<ErrorBody["details"]>)
    : []
  return new CliError(ExitCode.ApiError, {
    type: error.type,
    message: typeof error.message === "string" ? error.message : "",
    ...(typeof error.request_id === "string" && {
      request_id: error.request_id,
    }),
    ...(details.length > 0 && { details }),
  })
}

/** A project the person belongs to (GET /v1/projects). */
export interface Project {
  id: string
  object: "project"
  organization_id: string
  name: string
  slug: string
}

/** A page of projects, as the API sends it. */
export interface ProjectPage {
  data: Project[]
  meta: { next_cursor: string | null; has_more: boolean }
}

function isProjectPage(body: unknown): body is ProjectPage {
  return (
    isObject(body) &&
    Array.isArray(body.data) &&
    body.data.every(
      (project) =>
        isObject(project) &&
        typeof project.id === "string" &&
        typeof project.name === "string" &&
        typeof project.slug === "string"
    ) &&
    isObject(body.meta)
  )
}

/** One page of the person's projects (a CLI session's; an API key gets 403). */
export async function projectPage(
  runtime: Runtime,
  apiUrl: string,
  token: string,
  query: { limit: number; cursor?: string }
): Promise<ProjectPage> {
  const params = new URLSearchParams({ limit: String(query.limit) })
  if (query.cursor) params.set("cursor", query.cursor)
  const path = `/v1/projects?${params.toString()}`
  const answer = await send(runtime, apiUrl, "GET", path, { token })
  if ("unreachable" in answer) throw answer.unreachable
  if (answer.status === 200 && isProjectPage(answer.body)) return answer.body
  throw apiError(answer.status, answer.body)
}

/** Every project of the person's, following the cursors. */
export async function allProjects(
  runtime: Runtime,
  apiUrl: string,
  token: string
): Promise<Project[]> {
  const projects: Project[] = []
  let cursor: string | undefined
  do {
    const page = await projectPage(runtime, apiUrl, token, {
      limit: 100,
      cursor,
    })
    projects.push(...page.data)
    cursor = page.meta.has_more
      ? (page.meta.next_cursor ?? undefined)
      : undefined
  } while (cursor)
  return projects
}
