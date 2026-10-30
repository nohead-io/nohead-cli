import { describe, expect, it, onTestFinished, vi } from "vitest"

import { run } from "../cli.ts"
import { ExitCode } from "../errors.ts"
import { contractResponse } from "../test/contract.ts"
import { ME, PROJECT_ID } from "../test/fixtures.ts"
import { testRuntime, type Handler } from "../test/runtime.ts"

// The sign-in endpoints are outside the /v1 contract, so their stubs are
// plain JSON responses in the shapes the API answers with.
const HOME = "/home/ada"
const CONFIG = "/home/ada/.config/nohead/config.json"
const PAGE = "https://app.nohead.test/cli/login?code=WXYZ-4821"
const TOKEN = "nohead_sk_new0000000_secret"
const KEY_ID = "key_01J9ZQ3F8X5W2K7M4N6P0R1S2N"

const started = (overrides: Record<string, unknown> = {}) =>
  Response.json(
    {
      device_code: "device-code-secret",
      user_code: "WXYZ-4821",
      verification_uri: "https://app.nohead.test/cli/login",
      verification_uri_complete: PAGE,
      expires_in: 600,
      interval: 5,
      ...overrides,
    },
    { status: 201 }
  )
const pending = (interval = 5) =>
  Response.json({ status: "pending", interval }, { status: 202 })
const approved = (project_id = PROJECT_ID) =>
  Response.json(
    {
      token: TOKEN,
      api_key: {
        id: KEY_ID,
        name: "CLI on ada-laptop",
        scopes: ["records:read", "records:write"],
        published_only: false,
        project_id,
        expires_at: null,
      },
      project: { id: project_id, name: "Blog" },
    },
    { status: 201 }
  )
const failure = (
  status: number,
  type: string,
  message: string,
  details: unknown[] = [],
  headers: Record<string, string> = {}
) =>
  Response.json(
    {
      error: {
        type,
        message,
        request_id: "req_01J9ZQ3F8X5W2K7M4N6P0R1S2T",
        details,
      },
    },
    { status, headers }
  )
const unreachable = () => {
  throw new TypeError("fetch failed")
}
/** A 201 whose body never arrives whole (the connection dropped). */
const cutOff = () =>
  new Response(
    new ReadableStream({
      start: (controller) => controller.error(new TypeError("terminated")),
    }),
    { status: 201 }
  )
const unavailable = () =>
  failure(503, "service_unavailable", "The service is unavailable")
const rateLimited = (after: string) =>
  failure(429, "rate_limited", "Too many requests", [], {
    "Retry-After": after,
  })

/**
 * `nohead login` at a terminal against stubbed sign-in endpoints: each
 * endpoint answers from its list, in order. Sleeping moves the clock on.
 */
function browserLogin(
  polls: Handler[],
  {
    start = [() => started()],
    env = {},
    files = {},
  }: {
    start?: Handler[]
    env?: Record<string, string | undefined>
    files?: Record<string, string>
  } = {}
) {
  const starts = [...start]
  const answers = [...polls]
  const t = testRuntime({
    env: { HOME, NOHEAD_API_URL: "http://api.test", ...env },
    files,
    routes: {
      "POST /auth/cli-logins": (request) => {
        const answer = starts.shift()
        if (!answer) throw new Error("started once too often")
        return answer(request)
      },
      "POST /auth/cli-logins/token": (request) => {
        const answer = answers.shift()
        if (!answer) throw new Error("polled once too often")
        return answer(request)
      },
    },
  })
  let clock = Date.parse("2026-09-27T12:00:00.000Z")
  const sleeps: number[] = []
  t.runtime.stdinIsTTY = true
  t.runtime.readStdin = async () => {
    throw new Error("a terminal's stdin is not read")
  }
  t.runtime.now = () => new Date(clock)
  t.runtime.sleep = async (ms) => {
    sleeps.push(ms)
    clock += ms
  }
  const openUrl = vi.fn<(url: string) => boolean>(() => true)
  t.runtime.openUrl = openUrl
  const bodies = () =>
    Promise.all(
      t.requests.map(async (request) => [
        `${request.method} ${new URL(request.url).pathname}`,
        JSON.parse(await request.clone().text()),
      ])
    )
  const config = () => JSON.parse(t.text(CONFIG))
  return { ...t, sleeps, openUrl, bodies, config }
}

const lines = (...text: string[]) => [...text, ""].join("\n")

describe("login in the browser", () => {
  it("shows the code, opens the page, waits for Allow and saves the new key under its project", async () => {
    const t = browserLogin([
      () => pending(),
      () => pending(7),
      () => approved(),
    ])

    await t.ok(["login"])

    expect(await t.bodies()).toEqual([
      ["POST /auth/cli-logins", { client_name: "ada-laptop" }],
      ["POST /auth/cli-logins/token", { device_code: "device-code-secret" }],
      ["POST /auth/cli-logins/token", { device_code: "device-code-secret" }],
      ["POST /auth/cli-logins/token", { device_code: "device-code-secret" }],
    ])
    expect(t.requests[0].url).toBe("http://api.test/auth/cli-logins")
    expect(t.requests[0].headers.get("Authorization")).toBeNull()
    expect(t.requests[0].headers.get("Nohead-Client")).toMatch(/^cli\//)
    // The interval the API asks for while pending is honored.
    expect(t.sleeps).toEqual([5000, 5000, 7000])
    expect(t.openUrl).toHaveBeenCalledExactlyOnceWith(PAGE)
    expect(t.err()).toBe(
      lines(
        "Your code: WXYZ-4821",
        `Opening ${PAGE} — check the code matches, then choose Allow.`,
        "Waiting for you to choose Allow (Ctrl-C to stop)…"
      )
    )
    expect(t.config()).toEqual({
      keys: {
        [PROJECT_ID]: {
          api_url: "http://api.test",
          api_key: TOKEN,
          name: "CLI on ada-laptop",
        },
      },
    })
    expect(t.out()).toBe(
      lines(
        `Logged in to http://api.test with API key CLI on ada-laptop (project ${PROJECT_ID}).`,
        `Saved the key for project ${PROJECT_ID} in ${CONFIG}.`
      )
    )
    expect(t.out() + t.err()).not.toContain(TOKEN)
  })

  // A coding agent runs the CLI without a terminal, with nothing on stdin:
  // it shows its person the code and the page.
  it("signs in with the browser without a terminal when nothing is piped in", async () => {
    const t = browserLogin([() => approved()])
    t.runtime.stdinIsTTY = false
    t.runtime.readStdin = async () => ""

    await t.ok(["login"])

    expect(t.err()).toContain("Your code: WXYZ-4821")
    expect(t.config().keys[PROJECT_ID].api_key).toBe(TOKEN)
  })

  it("prints the page to open when there is no browser to open it in", async () => {
    const t = browserLogin([() => approved()])
    t.openUrl.mockReturnValue(false)

    await t.ok(["login"])

    expect(t.openUrl).toHaveBeenCalledExactlyOnceWith(PAGE)
    expect(t.err()).toBe(
      lines(
        "Your code: WXYZ-4821",
        `Open ${PAGE} in a browser — check the code matches, then choose Allow.`,
        "Waiting for you to choose Allow (Ctrl-C to stop)…"
      )
    )
  })

  // The opener would start whatever the URL names.
  it.each([
    "file:///etc/passwd",
    "javascript:alert(1)",
    "calculator:",
    "not a url",
  ])("never hands %s to the browser opener", async (url) => {
    const t = browserLogin([() => approved()], {
      start: [() => started({ verification_uri_complete: url })],
    })

    await t.ok(["login"])

    expect(t.openUrl).not.toHaveBeenCalled()
    expect(t.err()).toContain(`Open ${url} in a browser`)
  })

  it("prints the same JSON document as for a piped key, with the code on stderr", async () => {
    const t = browserLogin([() => approved()])

    await t.ok(["--json", "login"])

    expect(t.json()).toEqual({
      api_url: "http://api.test",
      project_id: PROJECT_ID,
      api_key: { id: KEY_ID, name: "CLI on ada-laptop" },
      replaced: false,
      config: CONFIG,
    })
    // Without the code and the page, nobody could approve.
    expect(t.err()).toBe(
      lines(
        "Your code: WXYZ-4821",
        `Opening ${PAGE} — check the code matches, then choose Allow.`,
        "Waiting for you to choose Allow (Ctrl-C to stop)…"
      )
    )
  })

  describe("suggests the project", () => {
    const link = {
      "/work/nohead.json": JSON.stringify({ project: "prj_link" }),
    }

    it.each([
      { from: "--project", argv: ["--project", "prj_flag"], want: "prj_flag" },
      {
        from: "NOHEAD_PROJECT",
        env: { NOHEAD_PROJECT: "prj_env" },
        want: "prj_env",
      },
      { from: "nohead.json", files: link, want: "prj_link" },
      // NOHEAD_API_KEY's project is not one this folder asks for.
      {
        from: "nohead.json, with NOHEAD_API_KEY set",
        files: link,
        env: { NOHEAD_API_KEY: "nohead_sk_env" },
        want: "prj_link",
      },
    ])("from $from", async ({ argv = [], env = {}, files = {}, want }) => {
      const t = browserLogin([() => approved()], { env, files })

      await t.ok([...argv, "login"])

      expect((await t.bodies())[0]).toEqual([
        "POST /auth/cli-logins",
        { client_name: "ada-laptop", project_id: want },
      ])
    })

    it.each([
      { from: "NOHEAD_API_KEY", env: { NOHEAD_API_KEY: "nohead_sk_env" } },
      {
        from: "the only saved key",
        files: {
          [CONFIG]: JSON.stringify({
            keys: { prj_saved: { api_url: "http://api.test", api_key: "k" } },
          }),
        },
      },
      {
        from: "several saved keys, none chosen",
        files: {
          [CONFIG]: JSON.stringify({
            keys: {
              prj_a: { api_url: "http://api.test", api_key: "a" },
              prj_b: { api_url: "http://api.test", api_key: "b" },
            },
          }),
        },
      },
    ])("not from $from", async ({ env = {}, files = {} }) => {
      const t = browserLogin([() => approved()], { env, files })

      await t.ok(["login"])

      expect((await t.bodies())[0]).toEqual([
        "POST /auth/cli-logins",
        { client_name: "ada-laptop" },
      ])
    })
  })

  it("replaces the chosen project's saved key, and says when the folder uses another project", async () => {
    const t = browserLogin([() => approved()], {
      files: {
        "/work/nohead.json": JSON.stringify({ project: "prj_link" }),
        [CONFIG]: JSON.stringify({
          keys: {
            [PROJECT_ID]: {
              api_url: "http://api.test",
              api_key: "nohead_sk_old",
            },
            prj_link: { api_url: "http://api.test", api_key: "nohead_sk_link" },
          },
        }),
      },
    })

    await t.ok(["login"])

    expect(t.config().keys).toEqual({
      [PROJECT_ID]: {
        api_url: "http://api.test",
        api_key: TOKEN,
        name: "CLI on ada-laptop",
      },
      prj_link: { api_url: "http://api.test", api_key: "nohead_sk_link" },
    })
    expect(t.out()).toContain(
      `Replaced the saved key for project ${PROJECT_ID}`
    )
    expect(t.err()).toContain(
      `Commands here use project prj_link (from /work/nohead.json), not ${PROJECT_ID}`
    )
  })

  it("stops when the person denies it", async () => {
    const t = browserLogin([
      () => pending(),
      () =>
        failure(403, "authorization_error", "access_denied", [
          { code: "access_denied", message: "The sign-in was denied" },
        ]),
    ])

    expect(await run(["login"], t.runtime)).toBe(ExitCode.ApiError)

    expect(t.err()).toContain("Error: Sign-in was denied in the browser")
    expect(t.written).toEqual({})
  })

  it("stops when the API says the request expired or was already used", async () => {
    const t = browserLogin([
      unavailable,
      () => pending(),
      () => failure(404, "not_found", "No such sign-in request"),
    ])

    expect(await run(["--json", "login"], t.runtime)).toBe(ExitCode.ApiError)

    expect(JSON.parse(t.err().split("…\n")[1]).error).toEqual({
      type: "not_found",
      message:
        "The sign-in request expired or was already used; run nohead login again",
      request_id: "req_01J9ZQ3F8X5W2K7M4N6P0R1S2T",
    })
    expect(t.written).toEqual({})
  })

  // The API hands the key over once: if that answer is lost, the next poll
  // gets a 404 for a request that made a key.
  it.each([
    ["no answer", unreachable],
    ["a 503", unavailable],
    ["its answer cut off", cutOff],
  ])(
    "says a key may have been made when a 404 follows a pick-up with %s",
    async (_, lost) => {
      const t = browserLogin([
        () => pending(),
        lost,
        () => rateLimited("1"),
        () => failure(404, "not_found", "No such sign-in request"),
      ])

      expect(await run(["login"], t.runtime)).toBe(ExitCode.ApiError)

      expect(t.err()).toContain(
        "Error: The sign-in request expired or was already used; if you chose Allow, its API key was lost on the way: revoke it in the web app (API keys), then run nohead login again"
      )
      expect(t.written).toEqual({})
    }
  )

  it("stops polling when the request runs out of time", async () => {
    const t = browserLogin(Array.from({ length: 200 }, () => () => pending()))

    expect(await run(["login"], t.runtime)).toBe(ExitCode.ApiError)

    // Every 5 seconds for 600 seconds.
    expect(t.requests).toHaveLength(1 + 119)
    expect(t.sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(600_000)
    expect(t.err()).toContain(
      "Error: The sign-in request expired; run nohead login again"
    )
  })

  it("waits as long as a 429's Retry-After says, from 1 to 60 seconds", async () => {
    const t = browserLogin([
      () => rateLimited("30"),
      () => rateLimited("3600"),
      () => rateLimited("0"),
      () => approved(),
    ])

    await t.ok(["login"])

    expect(t.sleeps).toEqual([5000, 30_000, 60_000, 1000])
    expect(t.err()).not.toContain("Rate limited")
  })

  it("keeps polling through failures until the request expires, saying so once", async () => {
    const t = browserLogin([
      unreachable,
      unavailable,
      unreachable,
      () => pending(),
      () => approved(),
    ])

    await t.ok(["login"])

    expect(t.sleeps).toEqual([5000, 5000, 5000, 5000, 5000])
    expect(t.err()).toBe(
      lines(
        "Your code: WXYZ-4821",
        `Opening ${PAGE} — check the code matches, then choose Allow.`,
        "Waiting for you to choose Allow (Ctrl-C to stop)…",
        "Could not reach the API; still trying"
      )
    )
    expect(t.config().keys[PROJECT_ID].api_key).toBe(TOKEN)
  })

  it("reports the API unreachable when it stays so until the request expires", async () => {
    const t = browserLogin(Array.from({ length: 200 }, () => unreachable))

    expect(await run(["login"], t.runtime)).toBe(ExitCode.Network)

    expect(t.err()).toContain("Error: Could not reach the API: fetch failed")
  })

  it("asks again when starting fails for a while, as the SDK does", async () => {
    const t = browserLogin([() => approved()], {
      start: [
        unavailable,
        () => rateLimited("2"),
        unreachable,
        () => started(),
      ],
    })

    await t.ok(["login"])

    expect(t.sleeps).toEqual([500, 2000, 2000, 5000])
    expect(t.err()).toContain(
      lines(
        "API unavailable (HTTP 503); retrying",
        "Rate limited; retrying in 2s",
        "Could not reach the API; retrying",
        "Your code: WXYZ-4821"
      )
    )
  })

  it("gives up starting after 3 retries, with the API's error", async () => {
    const t = browserLogin([], {
      start: [unavailable, unavailable, unavailable, unavailable],
    })

    expect(await run(["login"], t.runtime)).toBe(ExitCode.ApiError)

    expect(t.requests).toHaveLength(4)
    expect(t.err()).toContain("Error: The service is unavailable")
    expect(t.err()).toContain("Request ID: req_01J9ZQ3F8X5W2K7M4N6P0R1S2T")
  })

  it("reports an API that can't be reached with exit code 3", async () => {
    const t = browserLogin([], {
      start: [unreachable, unreachable, unreachable, unreachable],
    })

    expect(await run(["login"], t.runtime)).toBe(ExitCode.Network)

    expect(t.err()).toContain("Error: Could not reach the API: fetch failed")
  })

  it("reports the API's error for a refused start, as for any API error", async () => {
    const t = browserLogin([], {
      env: { NOHEAD_PROJECT: "prj_gone" },
      start: [
        () =>
          failure(422, "validation_error", "Validation failed", [
            { field: "project_id", code: "invalid", message: "is invalid" },
          ]),
      ],
    })

    expect(await run(["--json", "login"], t.runtime)).toBe(ExitCode.ApiError)

    expect(t.json).toThrow() // nothing on stdout
    expect(JSON.parse(t.err()).error).toEqual({
      type: "validation_error",
      message: "Validation failed",
      request_id: "req_01J9ZQ3F8X5W2K7M4N6P0R1S2T",
      details: [
        { field: "project_id", code: "invalid", message: "is invalid" },
      ],
    })
  })

  it("never signs in to an API over plain http", async () => {
    const t = browserLogin([], {
      env: { NOHEAD_API_URL: "http://api.example.com" },
    })

    expect(await run(["login"], t.runtime)).toBe(ExitCode.Usage)

    expect(t.err()).toContain("use https")
    expect(t.requests).toHaveLength(0)
  })
})

describe("login with a piped key", () => {
  it("checks and saves the key as before, without the browser", async () => {
    const t = testRuntime({
      env: { HOME, NOHEAD_API_URL: "http://api.test" },
      stdin: "nohead_sk_test0000000_secret\n",
      routes: { "GET /v1/me": () => contractResponse("me_get", ME) },
    })
    t.runtime.openUrl = () => {
      throw new Error("a piped key needs no browser")
    }

    await t.ok(["--json", "login"])

    expect(t.requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/v1/me",
    ])
    expect(t.err()).toBe("")
    expect(t.json()).toEqual({
      api_url: "http://api.test",
      project_id: PROJECT_ID,
      api_key: { id: ME.api_key.id, name: "ci" },
      replaced: false,
      config: CONFIG,
    })
    expect(JSON.parse(t.text(CONFIG)).keys[PROJECT_ID].api_key).toBe(
      "nohead_sk_test0000000_secret"
    )
  })

  // A pipe left open (ssh without -t) never ends, so the read never does.
  it("says what it waits for when nothing arrives on stdin for a second", async () => {
    const t = testRuntime({
      env: { HOME, NOHEAD_API_URL: "http://api.test" },
      routes: { "GET /v1/me": () => contractResponse("me_get", ME) },
    })
    const { promise, resolve } = Promise.withResolvers<string>()
    t.runtime.readStdin = () => promise
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    onTestFinished(() => void vi.useRealTimers())

    const login = run(["login"], t.runtime)
    await vi.advanceTimersByTimeAsync(999)
    expect(t.err()).toBe("")
    await vi.advanceTimersByTimeAsync(1)
    expect(t.err()).toBe(
      "Waiting for an API key on stdin… (close it, or run in a terminal, to sign in with the browser)\n"
    )

    // It goes on reading: a key that arrives later is saved.
    resolve("nohead_sk_test0000000_secret\n")
    expect(await login).toBe(ExitCode.Success)
    expect(JSON.parse(t.text(CONFIG)).keys[PROJECT_ID].api_key).toBe(
      "nohead_sk_test0000000_secret"
    )
  })

  it("says nothing more when the key arrives within a second", async () => {
    const t = testRuntime({
      env: { HOME, NOHEAD_API_URL: "http://api.test" },
      routes: { "GET /v1/me": () => contractResponse("me_get", ME) },
    })
    const { promise, resolve } = Promise.withResolvers<string>()
    t.runtime.readStdin = () => promise
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    onTestFinished(() => void vi.useRealTimers())

    const login = run(["login"], t.runtime)
    await vi.advanceTimersByTimeAsync(500)
    resolve("nohead_sk_test0000000_secret\n")
    expect(await login).toBe(ExitCode.Success)
    await vi.advanceTimersByTimeAsync(1000)
    expect(t.err()).toBe("")
  })

  it("refuses an empty pipe (an unset variable) instead of waiting for a browser", async () => {
    const t = testRuntime({ env: { HOME }, stdin: "\n", routes: {} })
    expect(await run(["login"], t.runtime)).toBe(ExitCode.Usage)
    expect(t.err()).toContain("No API key given on stdin")
    expect(t.requests).toHaveLength(0)
  })

  it("refuses to wait for a browser sign-in in CI", async () => {
    const t = testRuntime({ env: { HOME, CI: "true" }, stdin: "", routes: {} })
    expect(await run(["login"], t.runtime)).toBe(ExitCode.Usage)
    expect(t.err()).toContain("in CI, set NOHEAD_API_KEY")
    expect(t.requests).toHaveLength(0)
  })
})
