import { describe, expect, it, vi } from "vitest"

import { run } from "../cli.ts"
import { ExitCode } from "../errors.ts"
import { contractResponse } from "../test/contract.ts"
import { ME, PROJECT_ID } from "../test/fixtures.ts"
import { testRuntime, type Handler } from "../test/runtime.ts"

// The sign-in endpoints are the web app's, outside the /v1 contract, so
// their stubs are plain JSON responses in the shape the API documents.
const HOME = "/home/ada"
const CONFIG = "/home/ada/.config/nohead/config.json"
const PAGE = "https://app.nohead.test/cli/login?code=WXYZ-4821"
const TOKEN = "nohead_cli_new0000000secret"
const USER = {
  id: "usr_01J9ZQ3F8X5W2K7M4N6P0R1S2T",
  email: "ada@example.com",
  name: "Ada Lovelace",
}
const SESSION = {
  id: "ses_01J9ZQ3F8X5W2K7M4N6P0R1S2T",
  object: "cli_session",
  name: "CLI on ada-laptop",
  last_used_at: null,
  expires_at: "2026-12-26T12:00:00.000Z",
  created_at: "2026-09-27T12:00:00.000Z",
}

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
const approved = (
  project: { id: string; name: string } | null = {
    id: PROJECT_ID,
    name: "Blog",
  }
) =>
  Response.json(
    { token: TOKEN, session: SESSION, user: USER, project },
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

/**
 * `nohead login` at a terminal against stubbed sign-in endpoints: the token
 * endpoint answers from `polls`, in order. Sleeping moves the clock on.
 */
function browserLogin(
  polls: Handler[],
  {
    start = [() => started()],
    env = {},
  }: { start?: Handler[]; env?: Record<string, string> } = {}
) {
  const starts = [...start]
  const answers = [...polls]
  const t = testRuntime({
    env: { HOME, NOHEAD_API_URL: "http://api.test", ...env },
    routes: {
      "POST /auth/cli-logins": (request) => starts.shift()!(request),
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
    throw new Error("the browser flow reads no stdin")
  }
  t.runtime.readSecret = async () => {
    throw new Error("the browser flow asks for no key")
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
  return { ...t, sleeps, openUrl, bodies }
}

describe("login in the browser", () => {
  it("shows the code, opens the page, waits for Allow and saves the new session", async () => {
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
    expect(t.requests[0].headers.get("Authorization")).toBeNull()
    // The interval the API asks for while pending is honored.
    expect(t.sleeps).toEqual([5000, 5000, 7000])
    expect(t.openUrl).toHaveBeenCalledWith(PAGE)
    expect(t.err()).toBe(
      [
        "Your code: WXYZ-4821",
        `Opening ${PAGE} — confirm the code matches, then choose Allow.`,
        "Waiting for you to choose Allow (Ctrl-C to stop)…",
        "",
      ].join("\n")
    )
    expect(JSON.parse(t.text(CONFIG))).toEqual({
      profiles: {
        default: {
          api_url: "http://api.test",
          token: TOKEN,
          project_id: PROJECT_ID,
        },
      },
    })
    expect(t.out()).toBe(
      [
        "Logged in to http://api.test as ada@example.com.",
        `Default project: Blog (${PROJECT_ID}).`,
        `Saved as profile "default" in ${CONFIG}.`,
        "",
      ].join("\n")
    )
    expect(t.out() + t.err()).not.toContain(TOKEN)
  })

  // A coding agent runs the CLI without a terminal: --web still signs in
  // through the browser, and the agent shows its person the code.
  it("signs in through the browser without a terminal when asked with --web", async () => {
    const t = browserLogin([() => approved()])
    t.runtime.stdinIsTTY = false

    await t.ok(["login", "--web", "--no-browser"])

    expect(t.openUrl).not.toHaveBeenCalled()
    expect(t.err()).toContain("Your code: WXYZ-4821")
    expect(JSON.parse(t.text(CONFIG)).profiles.default.token).toBe(TOKEN)
  })

  it("saves the key as the --profile named", async () => {
    const t = browserLogin([() => approved()])
    await t.ok(["--profile", "staging", "login"])
    expect(Object.keys(JSON.parse(t.text(CONFIG)).profiles)).toEqual([
      "staging",
    ])
  })

  it("prints one JSON document, with progress on stderr", async () => {
    const t = browserLogin([() => approved()])

    await t.ok(["--json", "login"])

    expect(t.json()).toEqual({
      profile: "default",
      api_url: "http://api.test",
      user: USER,
      session: {
        id: SESSION.id,
        name: "CLI on ada-laptop",
        expires_at: SESSION.expires_at,
      },
      project: { id: PROJECT_ID, name: "Blog" },
      config: CONFIG,
    })
    expect(t.out()).not.toContain(TOKEN)
    // Without the code and the page, nobody could approve.
    expect(t.err()).toContain("Your code: WXYZ-4821")
  })

  it("hints at nohead use when no default project was chosen", async () => {
    const t = browserLogin([() => approved(null)])

    await t.ok(["login"])

    expect(JSON.parse(t.text(CONFIG)).profiles.default).toEqual({
      api_url: "http://api.test",
      token: TOKEN,
    })
    expect(t.out()).toContain(
      "No default project yet: choose one with `nohead use <project>`"
    )
  })

  it("stops when the person denies it", async () => {
    const t = browserLogin([
      () => pending(),
      () =>
        failure(403, "authorization_error", "The sign-in was denied", [
          { code: "access_denied", message: "Denied in the browser" },
        ]),
    ])

    expect(await run(["login"], t.runtime)).toBe(ExitCode.ApiError)
    expect(t.err()).toContain("Error: Sign-in was denied in the browser")
    expect(t.written).toEqual({})
  })

  it("stops when the request expired", async () => {
    const t = browserLogin([
      () => failure(404, "not_found", "No such sign-in request"),
    ])

    expect(await run(["--json", "login"], t.runtime)).toBe(ExitCode.ApiError)
    expect(JSON.parse(t.err().slice(t.err().indexOf("{"))).error).toEqual({
      type: "not_found",
      message: "The sign-in request expired; run nohead login again",
      request_id: "req_01J9ZQ3F8X5W2K7M4N6P0R1S2T",
    })
    expect(t.written).toEqual({})
  })

  it("stops polling once the request's time is up", async () => {
    const t = browserLogin([() => pending(), () => pending()], {
      start: [() => started({ expires_in: 12 })],
    })

    expect(await run(["login"], t.runtime)).toBe(ExitCode.ApiError)
    expect(t.err()).toContain(
      "Error: The sign-in request expired; run nohead login again"
    )
    expect(t.sleeps).toEqual([5000, 5000, 5000])
    expect(t.requests).toHaveLength(3)
  })

  it("waits as long as the API asks when polled too fast, and when busy", async () => {
    const t = browserLogin(
      [
        () =>
          failure(429, "rate_limited", "Slow down", [], {
            "Retry-After": "20",
          }),
        () => approved(),
      ],
      {
        start: [
          () =>
            failure(429, "rate_limited", "Slow down", [], {
              "Retry-After": "3",
            }),
          () => started(),
        ],
      }
    )

    await t.ok(["login"])
    expect(t.sleeps).toEqual([3000, 5000, 20000])
    expect(t.err()).toContain("Rate limited; retrying in 3s")
  })

  it("keeps polling through a network failure", async () => {
    const t = browserLogin([
      () => {
        throw new TypeError("fetch failed")
      },
      () => {
        throw new TypeError("fetch failed")
      },
      () => approved(),
    ])

    await t.ok(["login"])
    // Said once, not on every poll.
    expect(
      t.err().match(/Could not reach the API; still trying/g)
    ).toHaveLength(1)
    expect(JSON.parse(t.text(CONFIG)).profiles.default.token).toBe(TOKEN)
  })

  it("shows other API errors as they are", async () => {
    const t = browserLogin([
      () =>
        failure(409, "conflict", "You have too many CLI sessions", [
          { code: "too_many", message: "End one on your Account page" },
        ]),
    ])

    expect(await run(["login"], t.runtime)).toBe(ExitCode.ApiError)
    expect(t.err()).toContain("Error: You have too many CLI sessions")
    expect(t.err()).toContain("  - End one on your Account page")
  })

  it("only prints the page with --no-browser, or when there is no browser", async () => {
    const t = browserLogin([() => approved()])
    await t.ok(["login", "--no-browser"])
    expect(t.openUrl).not.toHaveBeenCalled()
    expect(t.err()).toContain(
      `Open ${PAGE} in a browser — confirm the code matches, then choose Allow.`
    )

    // Over SSH, say.
    const ssh = browserLogin([() => approved()])
    ssh.openUrl.mockReturnValue(false)
    await ssh.ok(["login"])
    expect(ssh.err()).toContain(`Open ${PAGE} in a browser`)
  })

  it("never hands the browser opener anything but a web page", async () => {
    const t = browserLogin([() => approved()], {
      start: [
        () =>
          started({
            verification_uri_complete: "file:///Applications/Calc.app",
          }),
      ],
    })
    await t.ok(["login"])
    expect(t.openUrl).not.toHaveBeenCalled()
  })

  it("refuses an API over plain http before starting", async () => {
    const t = browserLogin([], {
      env: { NOHEAD_API_URL: "http://api.example.com" },
    })
    expect(await run(["login"], t.runtime)).toBe(ExitCode.Usage)
    expect(t.err()).toContain("use https")
    expect(t.requests).toHaveLength(0)
  })

  it("says when NOHEAD_API_KEY will still win over the new profile", async () => {
    const t = browserLogin([() => approved()], {
      env: { NOHEAD_API_KEY: "nohead_sk_env" },
    })
    await t.ok(["login"])
    expect(t.err()).toContain(
      "NOHEAD_API_KEY is set, so commands use it rather than this profile."
    )
  })
})

describe("login with a pasted key", () => {
  it("asks for a key at a terminal with --with-token", async () => {
    const t = testRuntime({
      env: { HOME, NOHEAD_API_URL: "http://api.test" },
      routes: { "GET /v1/me": () => contractResponse("me_get", ME) },
    })
    t.runtime.stdinIsTTY = true
    t.runtime.readSecret = async () => "nohead_sk_test0000000_secret\n"

    await t.ok(["login", "--with-token"])
    expect(t.requests.map((r) => new URL(r.url).pathname)).toEqual(["/v1/me"])
    expect(JSON.parse(t.text(CONFIG)).profiles.default).toEqual({
      api_url: "http://api.test",
      token: "nohead_sk_test0000000_secret",
      project_id: PROJECT_ID,
    })
    expect(t.out()).toContain(
      `Logged in to http://api.test as ci (project ${PROJECT_ID}).`
    )
  })

  it("reads a key piped in, never starting the browser flow", async () => {
    const t = testRuntime({
      env: { HOME, NOHEAD_API_URL: "http://api.test" },
      stdin: "nohead_sk_test0000000_secret\n",
      routes: { "GET /v1/me": () => contractResponse("me_get", ME) },
    })

    await t.ok(["login"])
    expect(t.requests.map((r) => new URL(r.url).pathname)).toEqual(["/v1/me"])
  })
})

describe("logout", () => {
  const signedIn = (token: string, routes: Record<string, Handler> = {}) =>
    testRuntime({
      env: { HOME },
      files: {
        [CONFIG]: JSON.stringify({
          profiles: {
            default: { api_url: "http://api.test", token },
            other: { api_url: "http://api.test", token: "nohead_sk_other" },
          },
        }),
      },
      routes,
    })

  it("ends the CLI session on the API, then forgets the profile", async () => {
    const t = signedIn(TOKEN, {
      "DELETE /auth/cli-session": () => new Response(null, { status: 204 }),
    })

    await t.ok(["logout"])

    expect(t.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      "DELETE http://api.test/auth/cli-session",
    ])
    expect(t.requests[0].headers.get("Authorization")).toBe(`Bearer ${TOKEN}`)
    expect(Object.keys(JSON.parse(t.text(CONFIG)).profiles)).toEqual(["other"])
    expect(t.out()).toBe(`Logged out of profile "default" (${CONFIG}).\n`)
    expect(t.err()).toBe("")
  })

  it("forgets the profile even when the session could not be ended, and says so", async () => {
    const t = signedIn(TOKEN, {
      "DELETE /auth/cli-session": () => {
        throw new TypeError("fetch failed")
      },
    })

    await t.ok(["logout"])
    expect(Object.keys(JSON.parse(t.text(CONFIG)).profiles)).toEqual(["other"])
    expect(t.err()).toContain(
      "Could not end the CLI session on the API; it stays valid until it expires"
    )

    const json = signedIn(TOKEN, {
      "DELETE /auth/cli-session": () =>
        failure(503, "service_unavailable", "Down for maintenance"),
    })
    await json.ok(["--json", "logout"])
    expect(json.json()).toEqual({
      profile: "default",
      removed: true,
      session_ended: false,
    })
    expect(json.err()).toBe("")
  })

  it("only forgets an API key, which stays valid", async () => {
    const t = signedIn("nohead_sk_saved")
    await t.ok(["--json", "logout"])
    expect(t.requests).toHaveLength(0)
    expect(t.json()).toEqual({ profile: "default", removed: true })
  })

  it("says when there is no such profile", async () => {
    const t = signedIn(TOKEN)
    await t.ok(["--profile", "nope", "logout"])
    expect(t.out()).toBe('No saved profile "nope".\n')
    expect(t.requests).toHaveLength(0)
  })
})
