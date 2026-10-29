// Signing in with the browser (`nohead login` at a terminal), as in OAuth's
// device authorization grant: the CLI starts a sign-in request, the person
// approves it in the web app, where they are signed in, and the CLI polls
// until the API hands it a new CLI session: a token that acts as the person,
// in every project they belong to.
//
// These endpoints are outside the /v1 API, so the SDK does not call them.

import type { Runtime } from "./context.ts"
import { CliError, ExitCode } from "./errors.ts"
import { isObject } from "./input.ts"
import { apiError, send } from "./web-api.ts"

/** A started sign-in request (POST /auth/cli-logins). */
interface CliLogin {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete?: string
  expires_in: number
  interval: number
}

/**
 * An approved sign-in: the new CLI session's token, once, the session, the
 * person, and the project they chose as the default, if any.
 */
export interface ApprovedLogin {
  token: string
  session: { id: string; name: string; expires_at: string | null }
  user: { id: string; email: string; name: string | null }
  project: { id: string; name: string } | null
}

/** Statuses worth asking again: the API is busy or briefly unavailable. */
const TRANSIENT = [429, 500, 502, 503, 504]

/** The longest wait between two requests, whatever the API asks for. */
const MAX_WAIT_SECONDS = 60

/** Seconds to wait, from 1 to MAX_WAIT_SECONDS; `fallback` if not a number. */
function seconds(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(Math.max(value, 1), MAX_WAIT_SECONDS)
    : fallback
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
    isObject(body.session) &&
    typeof body.session.id === "string" &&
    isObject(body.user) &&
    typeof body.user.email === "string" &&
    (body.project === null ||
      (isObject(body.project) && typeof body.project.id === "string"))
  )
}

/** Starts a sign-in request, asking again (up to 3 times) when the API is busy. */
async function start(
  runtime: Runtime,
  apiUrl: string,
  notify: (message: string) => void
): Promise<CliLogin> {
  // The session the API makes is named after this machine.
  const client_name = runtime.hostname().slice(0, 100) || "unknown"
  for (let attempt = 1; ; attempt++) {
    const answer = await send(runtime, apiUrl, "POST", "/auth/cli-logins", {
      body: { client_name },
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
    const answer = await send(
      runtime,
      apiUrl,
      "POST",
      "/auth/cli-logins/token",
      { body: { device_code: login.device_code } }
    )
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
      throw reworded(error, "Sign-in was denied in the browser")
    throw error
  }
}
