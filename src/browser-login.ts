// Signing in with the browser (`nohead login` with no key piped in), as in
// OAuth's device authorization grant: the CLI starts a sign-in request, the
// person approves it in the web app, where they are signed in and choose the
// project, scopes and expiry, and the CLI polls until the API hands it the
// new API key.
//
// These endpoints are outside the /v1 API, so the SDK does not call them:
// requests go through the runtime's fetch, and their errors are built into
// SDK errors to be reported as the SDK's are (errors.ts).

import { APIError, ConnectionError } from "@nohead/sdk"

import type { CommandContext } from "./context.ts"
import { CliError, cliError } from "./errors.ts"
import { isObject } from "./input.ts"
import { printNotice } from "./output.ts"
import { VERSION } from "./version.ts"

/** A started sign-in request (POST /auth/cli-logins). */
interface CliLogin {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete: string
  expires_in: number
  interval?: number
}

/** An approved sign-in: the new key, shown only this once. */
export interface ApprovedLogin {
  token: string
  api_key: { id: string; name: string; project_id: string }
}

/** What a POST to a sign-in endpoint came back with. */
interface Answer {
  /** Undefined when the API could not be reached. */
  status?: number
  body?: unknown
  /** The answer as an error, mapped as the SDK's are. */
  error: CliError
  /** A 429, a 5xx or no answer at all: worth asking again. */
  transient: boolean
  /** Retry-After, in seconds (clamped). */
  retryAfter?: number
}

/** Retries of a failed start, as many as the SDK makes. */
const START_RETRIES = 3

const EXPIRED = "The sign-in request expired; run nohead login again"
const DENIED = "Sign-in was denied in the browser"

/** Seconds to wait, from 1 to 60 whatever the API says; `fallback` if none. */
function seconds(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(Math.max(value, 1), 60)
    : fallback
}

/** Retry-After in seconds, given as seconds or as an HTTP date. */
function retryAfter(header: string | null, now: Date): number | undefined {
  if (!header?.trim()) return undefined
  const value = Number(header)
  if (Number.isFinite(value)) return value
  const date = Date.parse(header)
  return Number.isNaN(date) ? undefined : (date - now.getTime()) / 1000
}

/** One POST to a sign-in endpoint, never throwing for a failure. */
async function send(
  { runtime }: CommandContext,
  url: string,
  body: unknown
): Promise<Answer> {
  let response: Response
  try {
    response = await runtime.fetch(
      new Request(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Nohead-Client": `cli/${VERSION}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      })
    )
  } catch (cause) {
    return {
      error: cliError(new ConnectionError(`Could not reach ${url}`, { cause })),
      transient: true,
    }
  }
  const text = await response.text().catch(() => "")
  let parsed: unknown = text
  try {
    parsed = JSON.parse(text)
  } catch {
    // Not JSON (a proxy's error page): kept as text, as the SDK does.
  }
  const { status, headers } = response
  const after = retryAfter(headers.get("Retry-After"), runtime.now())
  return {
    status,
    body: parsed,
    error: cliError(new APIError(status, parsed, headers)),
    transient: status === 429 || status >= 500,
    retryAfter: after === undefined ? undefined : seconds(after, 1),
  }
}

/** Why a request is being asked again, as the SDK's retries say it. */
function failure(answer: Answer): string {
  return answer.status === undefined
    ? "Could not reach the API"
    : `API unavailable (HTTP ${answer.status})`
}

/** The same error in the CLI's words. */
const reworded = (error: CliError, message: string) =>
  new CliError(error.exitCode, { ...error.body, message })

function isCliLogin(body: unknown): body is CliLogin {
  return (
    isObject(body) &&
    typeof body.device_code === "string" &&
    typeof body.user_code === "string" &&
    typeof body.verification_uri === "string" &&
    typeof body.verification_uri_complete === "string" &&
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
    typeof body.api_key.project_id === "string"
  )
}

/**
 * Starts a sign-in request, asking again after a 429, a 5xx or no answer, up
 * to 3 times, with the SDK's backoff (or after Retry-After).
 */
async function start(
  ctx: CommandContext,
  url: string,
  body: unknown,
  notify: (message: string) => void
): Promise<CliLogin> {
  for (let attempt = 0; ; attempt++) {
    const answer = await send(ctx, url, body)
    if (answer.transient && attempt < START_RETRIES) {
      const wait = answer.retryAfter ?? 0.5 * 2 ** attempt
      notify(
        answer.status === 429
          ? `Rate limited; retrying in ${Math.ceil(wait)}s`
          : `${failure(answer)}; retrying`
      )
      await ctx.runtime.sleep(wait * 1000)
      continue
    }
    if (answer.status === 201 && isCliLogin(answer.body)) return answer.body
    throw answer.error
  }
}

/**
 * Signs in with the browser: starts a sign-in request (suggesting
 * `projectId`), shows its code and opens (or prints) the page to approve it
 * on, then polls until the person allows or denies it, or it expires. The
 * code and the page go to stderr even with --json: without them nobody can
 * approve.
 */
export async function browserLogin(
  ctx: CommandContext,
  apiUrl: string,
  projectId: string | undefined
): Promise<ApprovedLogin> {
  const { runtime, options } = ctx
  const say = (message: string) => printNotice(ctx, message)
  // With --json, stderr carries only the sign-in lines and an error.
  const notify = options.json ? () => {} : say
  const base = apiUrl.replace(/\/+$/, "")

  const login = await start(
    ctx,
    `${base}/auth/cli-logins`,
    {
      client_name: runtime.hostname(),
      ...(projectId && { project_id: projectId }),
    },
    notify
  )
  const page = login.verification_uri_complete
  say(`Your code: ${login.user_code}`)
  // The URL comes from the API, and the opener would start whatever else it
  // named (a file, another application): only a web page is opened.
  const web = ["https:", "http:"].includes(URL.parse(page)?.protocol ?? "")
  say(
    web && runtime.openUrl(page)
      ? `Opening ${page} — check the code matches, then choose Allow.`
      : `Open ${page} in a browser — check the code matches, then choose Allow.`
  )
  say("Waiting for you to choose Allow (Ctrl-C to stop)…")

  const deadline = runtime.now().getTime() + login.expires_in * 1000
  let interval = seconds(login.interval, 5)
  let wait = interval
  // The last failure while they go on, to report if the request expires.
  let failing: CliError | undefined
  for (;;) {
    await runtime.sleep(wait * 1000)
    if (runtime.now().getTime() >= deadline) throw failing ?? expired()
    const answer = await send(ctx, `${base}/auth/cli-logins/token`, {
      device_code: login.device_code,
    })
    wait = interval

    // Polled too fast: wait as long as the API asks, then go on.
    if (answer.status === 429) {
      wait = answer.retryAfter ?? interval
      continue
    }
    // Unreachable or unavailable: keep polling until the request expires.
    if (answer.transient) {
      if (!failing) notify(`${failure(answer)}; still trying`)
      failing = answer.error
      continue
    }
    failing = undefined

    const { status, body, error } = answer
    if (status === 202) {
      interval = seconds(isObject(body) ? body.interval : undefined, interval)
      wait = interval
      continue
    }
    if (status === 201 && isApproved(body)) return body
    if (status === 404) throw reworded(error, EXPIRED)
    if (
      status === 403 &&
      error.body.details?.some((detail) => detail.code === "access_denied")
    )
      throw reworded(error, DENIED)
    throw error
  }
}

/** A request that expired here, as the API reports one that expired there. */
const expired = () =>
  cliError(
    new APIError(
      404,
      { error: { type: "not_found", message: EXPIRED } },
      new Headers()
    )
  )
