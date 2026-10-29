// Signing in with the browser (`nohead login` at a terminal), as in OAuth's
// device authorization grant: the CLI starts a sign-in request, the person
// approves it in the web app, where they are signed in, and the CLI polls
// until the API hands it a new API key for the project they chose.
//
// These endpoints are the web app's, not the /v1 API's, so the SDK does not
// call them: requests go through the runtime's fetch directly.

import type { Runtime } from "./context.ts"
import { CliError, ExitCode, networkError, type ErrorBody } from "./errors.ts"
import { VERSION } from "./version.ts"

/** A started sign-in request (POST /auth/cli-logins). */
interface CliLogin {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete?: string
  expires_in: number
  interval: number
}

/** An approved sign-in: the new key, once, and its project. */
export interface ApprovedLogin {
  token: string
  api_key: { id: string; name: string; project_id: string }
  project: { id: string; name?: string }
}

type Answer =
  | { status: number; body: unknown; retryAfter?: number }
  | { unreachable: CliError }

/** Statuses worth asking again: the API is busy or briefly unavailable. */
const TRANSIENT = [429, 500, 502, 503, 504]

/** The longest wait between two requests, whatever the API asks for. */
const MAX_WAIT_SECONDS = 60

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

/** Seconds to wait, from 1 to MAX_WAIT_SECONDS; `fallback` if not a number. */
function seconds(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(Math.max(value, 1), MAX_WAIT_SECONDS)
    : fallback
}

/** Retry-After in seconds, given as seconds or as an HTTP date. */
function retryAfter(header: string | null, now: Date): number | undefined {
  if (!header) return undefined
  const value = Number(header)
  if (header.trim() !== "" && Number.isFinite(value)) return value
  const date = Date.parse(header)
  return Number.isNaN(date) ? undefined : (date - now.getTime()) / 1000
}

async function post(
  runtime: Runtime,
  apiUrl: string,
  path: string,
  body: unknown
): Promise<Answer> {
  let response: Response
  try {
    response = await runtime.fetch(
      new Request(`${apiUrl.replace(/\/+$/, "")}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Nohead-Client": `cli/${VERSION}`,
        },
        body: JSON.stringify(body),
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
function apiError(status: number, body: unknown): CliError {
  const error = isObject(body) ? body.error : undefined
  if (!isObject(error) || typeof error.type !== "string")
    return new CliError(ExitCode.ApiError, {
      type: "internal_error",
      message: `Unexpected API response (HTTP ${status})`,
    })
  const details = Array.isArray(error.details)
    ? (error.details as ErrorBody["details"])
    : []
  return new CliError(ExitCode.ApiError, {
    type: error.type,
    message: typeof error.message === "string" ? error.message : "",
    ...(typeof error.request_id === "string" && {
      request_id: error.request_id,
    }),
    ...(details && details.length > 0 && { details }),
  })
}

/** The same error, told in the CLI's words. */
function reworded(error: CliError, message: string): CliError {
  return new CliError(error.exitCode, { ...error.body, message })
}

const EXPIRED = "The sign-in request expired; run nohead login again"

function isCliLogin(body: unknown): body is CliLogin {
  return (
    isObject(body) &&
    typeof body.device_code === "string" &&
    typeof body.user_code === "string" &&
    typeof body.verification_uri === "string" &&
    typeof body.expires_in === "number"
  )
}

function isApproved(body: unknown): body is ApprovedLogin {
  return (
    isObject(body) &&
    typeof body.token === "string" &&
    isObject(body.api_key) &&
    typeof body.api_key.id === "string" &&
    typeof body.api_key.name === "string" &&
    typeof body.api_key.project_id === "string" &&
    isObject(body.project) &&
    typeof body.project.id === "string"
  )
}

/** Starts a sign-in request, asking again (up to 3 times) when the API is busy. */
async function start(
  runtime: Runtime,
  apiUrl: string,
  notify: (message: string) => void
): Promise<CliLogin> {
  // The key the API makes is named after this machine.
  const client_name = runtime.hostname().slice(0, 100) || "unknown"
  for (let attempt = 1; ; attempt++) {
    const answer = await post(runtime, apiUrl, "/auth/cli-logins", {
      client_name,
    })
    const transient =
      "unreachable" in answer || TRANSIENT.includes(answer.status)
    if (transient && attempt <= 3) {
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
      continue
    }
    if ("unreachable" in answer) throw answer.unreachable
    if (answer.status === 201 && isCliLogin(answer.body)) return answer.body
    throw apiError(answer.status, answer.body)
  }
}

/**
 * Signs in with the browser: starts a sign-in request, shows its code and
 * opens (or prints) the page to approve it on, then polls until the person
 * allows or denies it, or it expires. Progress goes to `notify`, a line at
 * a time.
 */
export async function browserLogin({
  runtime,
  apiUrl,
  openBrowser,
  notify,
}: {
  runtime: Runtime
  apiUrl: string
  openBrowser: boolean
  notify: (message: string) => void
}): Promise<ApprovedLogin> {
  const login = await start(runtime, apiUrl, notify)
  const page = login.verification_uri_complete ?? login.verification_uri
  // Only a web page is handed to the browser opener: the URL comes from the
  // API, and the opener would start whatever else it names.
  const web = ["https:", "http:"].includes(URL.parse(page)?.protocol ?? "")
  const opened = openBrowser && web && runtime.openUrl(page)
  notify(`Your code: ${login.user_code}`)
  notify(
    opened
      ? `Opening ${page} — confirm the code matches, then choose Allow.`
      : `Open ${page} in a browser — confirm the code matches, then choose Allow.`
  )
  notify("Waiting for you to choose Allow (Ctrl-C to stop)…")

  const deadline = runtime.now().getTime() + login.expires_in * 1000
  let interval = seconds(login.interval, 5)
  let wait = interval
  let failing = false
  for (;;) {
    await runtime.sleep(wait * 1000)
    if (runtime.now().getTime() >= deadline)
      throw new CliError(ExitCode.ApiError, {
        type: "not_found",
        message: EXPIRED,
      })
    const answer = await post(runtime, apiUrl, "/auth/cli-logins/token", {
      device_code: login.device_code,
    })
    wait = interval

    // Polled too fast: wait as long as the API asks, then go on.
    if (!("unreachable" in answer) && answer.status === 429) {
      wait = seconds(answer.retryAfter, interval)
      continue
    }
    // A failure on the way: keep polling until the request expires, saying
    // so once.
    if ("unreachable" in answer || TRANSIENT.includes(answer.status)) {
      if (!failing)
        notify(
          "unreachable" in answer
            ? "Could not reach the API; still trying"
            : `API unavailable (HTTP ${answer.status}); still trying`
        )
      failing = true
      continue
    }
    failing = false

    const { status, body } = answer
    if (status === 202) {
      interval = seconds(isObject(body) ? body.interval : undefined, interval)
      wait = interval
      continue
    }
    if (status === 201 && isApproved(body)) return body
    const error = apiError(status, body)
    if (status === 404) throw reworded(error, EXPIRED)
    if (
      status === 403 &&
      error.body.details?.some((detail) => detail.code === "access_denied")
    )
      throw reworded(
        error,
        "Sign-in was denied in the browser; no API key was created"
      )
    throw error
  }
}
