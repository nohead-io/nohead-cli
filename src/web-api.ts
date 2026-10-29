// Requests the SDK does not make: signing in with the browser and ending a
// CLI session (/auth, outside the /v1 API), and listing the person's projects
// (an operation of the web app's that a CLI session may call too). They go
// through the runtime's fetch directly.

import type { Runtime } from "./context.ts"
import { apiAnswerError, networkError, type CliError } from "./errors.ts"
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

/** Statuses worth asking again: the API is busy or briefly unavailable. */
export const TRANSIENT = [429, 500, 502, 503, 504]

/** The longest wait between two requests, whatever the API asks for. */
const MAX_WAIT_SECONDS = 60

/** Seconds to wait, from 1 to MAX_WAIT_SECONDS; `fallback` if not a number. */
export function seconds(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(Math.max(value, 1), MAX_WAIT_SECONDS)
    : fallback
}

/**
 * `send`, asking again (up to 3 times, as the SDK does) when the API can't
 * be reached or is busy, saying so through `notify`. Other answers, and
 * the last one, are returned as they come.
 */
export async function sendRetrying(
  runtime: Runtime,
  apiUrl: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  options: { token?: string; body?: unknown } = {},
  notify: (message: string) => void = () => {}
): Promise<Answer> {
  for (let attempt = 1; ; attempt++) {
    const answer = await send(runtime, apiUrl, method, path, options)
    const transient =
      "unreachable" in answer || TRANSIENT.includes(answer.status)
    if (!transient || attempt > 3) return answer
    const wait = seconds(
      "unreachable" in answer ? undefined : answer.retryAfter,
      2 ** (attempt - 1)
    )
    notify(
      "unreachable" in answer
        ? "Could not reach the API; retrying"
        : answer.status === 429
          ? `Rate limited; retrying in ${Math.ceil(wait)}s`
          : `API unavailable (HTTP ${answer.status}); retrying`
    )
    await runtime.sleep(wait * 1000)
  }
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
  const answer = await sendRetrying(runtime, apiUrl, "GET", path, { token })
  if ("unreachable" in answer) throw answer.unreachable
  if (answer.status === 200 && isProjectPage(answer.body)) return answer.body
  throw apiAnswerError(answer.status, answer.body)
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
