import { expect, onTestFinished, vi } from "vitest"

import { run } from "../cli.ts"
import type { Runtime } from "../context.ts"
import { ExitCode } from "../errors.ts"
import {
  assertMatchesContract,
  assertRequestMatchesContract,
} from "./contract.ts"

export type Handler = (request: Request) => Response | Promise<Response>

const rawResponses = new WeakSet<Response>()

/**
 * A stubbed API response the contract check leaves alone: one that breaks the
 * contract on purpose (a hostile API, a proxy's error page).
 */
export function raw(response: Response): Response {
  rawResponses.add(response)
  return response
}

/** Throws like Node's fs: with the error code and the path. */
function fsError(code: string, path: string) {
  return Object.assign(new Error(`${code}: ${path}`), { code, path })
}

/**
 * A runtime with captured output, an in-memory filesystem and a stubbed API.
 * Routes are "METHOD /path" (query strings ignored). Every /v1 request, and
 * every response to it not marked raw(), must match the contract
 * (openapi.yaml); unexpected requests fail too. A mismatch is answered with a
 * 400 and fails the test, whatever the exit code.
 */
export function testRuntime({
  routes = {},
  env = {
    NOHEAD_API_KEY: "nohead_sk_test0000000_secret",
    NOHEAD_API_URL: "http://api.test",
  },
  files = {},
  stdin = "",
  cwd = "/work",
}: {
  routes?: Record<string, Handler>
  env?: Runtime["env"]
  files?: Record<string, string | Uint8Array>
  stdin?: string
  /** The current directory, where nohead.json is looked for first. */
  cwd?: string
} = {}) {
  let stdout = ""
  let stderr = ""
  const written: Record<string, string | Uint8Array> = {}
  const requests: Request[] = []

  const mismatches: string[] = []
  onTestFinished(() => {
    if (mismatches.length > 0) throw new Error(mismatches.join("\n"))
  })
  const mismatch = (message: string) => {
    mismatches.push(message)
    return Response.json(
      { error: { type: "invalid_request", message } },
      { status: 400 }
    )
  }

  const fetch = vi.fn(async (request: Request) => {
    requests.push(request.clone())
    const url = new URL(request.url)
    const handler = routes[`${request.method} ${url.pathname}`]
    if (!handler)
      return mismatch(
        `Unexpected request: ${request.method} ${url.pathname}${url.search}`
      )
    if (!url.pathname.startsWith("/v1/")) return handler(request)

    let operationId: string
    try {
      const text = await request.clone().text()
      operationId = assertRequestMatchesContract({
        method: request.method,
        url: request.url,
        body: text ? JSON.parse(text) : undefined,
      })
    } catch (error) {
      return mismatch((error as Error).message)
    }
    const response = await handler(request)
    if (rawResponses.has(response)) return response
    let body: unknown
    try {
      body = await response.clone().json()
    } catch {
      return mismatch(
        `${request.method} ${url.pathname}: the stubbed ${response.status} response is not JSON; build it with contractResponse(), or mark it raw()`
      )
    }
    try {
      assertMatchesContract(operationId, response.status, body)
    } catch (error) {
      return mismatch((error as Error).message)
    }
    return response
  })

  const runtime: Runtime = {
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
    env,
    cwd: () => cwd,
    fetch: fetch as unknown as Runtime["fetch"],
    readFile: async (path) => {
      if (!(path in files)) throw fsError("ENOENT", path)
      const content = files[path]
      return typeof content === "string"
        ? content
        : new TextDecoder().decode(content)
    },
    readBinaryFile: async (path) => {
      if (!(path in files)) throw fsError("ENOENT", path)
      const content = files[path]
      return typeof content === "string"
        ? new TextEncoder().encode(content)
        : content
    },
    writeFile: async (path, content, options) => {
      if (options?.exclusive && (path in files || path in written))
        throw fsError("EEXIST", path)
      written[path] = content
    },
    readStdin: async () => stdin,
    stdinIsTTY: false,
    writePrivateFile: async (path, content) => {
      written[path] = content
      files[path] = content
    },
    sleep: async () => {},
    now: () => new Date("2026-09-27T12:00:00.000Z"),
    openUrl: () => false,
    hostname: () => "ada-laptop",
  }

  return {
    runtime,
    requests,
    written,
    /** Runs the CLI, expecting it to succeed (stderr says why it did not). */
    ok: async (argv: string[]) =>
      expect(await run(argv, runtime), stderr).toBe(ExitCode.Success),
    /** A written file as text. */
    text: (path: string) => {
      const content = written[path]
      return typeof content === "string"
        ? content
        : new TextDecoder().decode(content)
    },
    out: () => stdout,
    err: () => stderr,
    json: () => JSON.parse(stdout),
  }
}

/**
 * Makes AbortSignal.timeout, which fake timers don't drive, run on the fake
 * clock withoutWaiting runs, for the rest of the test. A test of a timeout
 * that stops using AbortSignal.timeout times out rather than passing.
 */
export function fakeTimeouts() {
  const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const controller = new AbortController()
    setTimeout(
      () => controller.abort(new DOMException("Timed out", "TimeoutError")),
      ms
    )
    return controller.signal
  })
  onTestFinished(() => timeout.mockRestore())
}

/**
 * Runs `work` on fake timers, so the SDK's retry backoff takes no time.
 */
export async function withoutWaiting<T>(work: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  try {
    const result = work()
    await vi.runAllTimersAsync()
    return await result
  } finally {
    vi.useRealTimers()
  }
}
