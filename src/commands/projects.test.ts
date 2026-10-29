import { describe, expect, it } from "vitest"

import { run } from "../cli.ts"
import { ExitCode } from "../errors.ts"
import { contractResponse } from "../test/contract.ts"
import { collection, ME, PROJECT_ID, REC_A, record } from "../test/fixtures.ts"
import { testRuntime, type Handler } from "../test/runtime.ts"

// A CLI session (`nohead login` in the browser) acts as its person in every
// project they belong to; requests name the project to work in.
const HOME = "/home/ada"
const CONFIG = "/home/ada/.config/nohead/config.json"
const TOKEN = "nohead_cli_saved000000secret"
const OTHER = "prj_01J9ZQ3F8X5W2K7M4N6P0R1S2U"
const ORG = "org_01J9ZQ3F8X5W2K7M4N6P0R1S2T"
const ORG_B = "org_01J9ZQ3F8X5W2K7M4N6P0R1S2U"

const page = <T>(data: T[], next_cursor: string | null = null) => ({
  data,
  meta: { next_cursor, has_more: next_cursor !== null },
})
const PERSON = {
  object: "principal" as const,
  type: "user" as const,
  user: {
    id: "usr_01J9ZQ3F8X5W2K7M4N6P0R1S2T",
    email: "ada@example.com",
    name: "Ada Lovelace",
    staff: false,
  },
  api_key: null,
}
const project = (
  id: string,
  name: string,
  slug: string,
  organization_id = ORG
) => ({
  id,
  object: "project",
  organization_id,
  name,
  slug,
  deleted_at: null,
  purge_after: null,
  created_at: "2026-09-27T12:00:00.000Z",
  updated_at: "2026-09-27T12:00:00.000Z",
})
const BLOG = project(PROJECT_ID, "Blog", "blog")
const DOCS = project(OTHER, "Docs", "docs")
// The list isn't in the public contract (it is the web app's), so its
// stub is plain JSON.
const projects =
  (...pages: ReturnType<typeof project>[][]): Handler =>
  (request) => {
    const cursor = new URL(request.url).searchParams.get("cursor")
    const index = cursor ? Number(cursor) : 0
    return Response.json(
      page(pages[index], index + 1 < pages.length ? String(index + 1) : null)
    )
  }

/** The CLI signed in with the browser: a saved session, maybe a project. */
function signedIn({
  project_id = PROJECT_ID,
  routes = {},
  env = {},
}: {
  /** null: none chosen yet. */
  project_id?: string | null
  routes?: Record<string, Handler>
  env?: Record<string, string>
} = {}) {
  const profile = {
    api_url: "http://api.test",
    token: TOKEN,
    ...(project_id ? { project_id } : {}),
  }
  return testRuntime({
    env: { HOME, ...env },
    files: { [CONFIG]: JSON.stringify({ profiles: { default: profile } }) },
    routes,
  })
}

describe("a CLI session's project", () => {
  const routes = {
    "GET /v1/collections/posts/records": () =>
      contractResponse("records_list", page([record(REC_A, { title: "Hi" })])),
    [`GET /v1/projects/${PROJECT_ID}/collections`]: () =>
      contractResponse("collections_list", page([collection()])),
    [`GET /v1/projects/${OTHER}/collections`]: () =>
      contractResponse("collections_list", page([collection()])),
  }
  const sent = (t: ReturnType<typeof signedIn>) =>
    t.requests.map(
      (r) =>
        `${new URL(r.url).pathname} ${r.headers.get("Authorization")} ${r.headers.get("Nohead-Project")}`
    )

  it("is named on every request, so collections can go by slug", async () => {
    const t = signedIn({ routes })

    await t.ok(["records", "list", "posts"])
    await t.ok(["collections", "list"])

    expect(sent(t)).toEqual([
      `/v1/collections/posts/records Bearer ${TOKEN} ${PROJECT_ID}`,
      `/v1/projects/${PROJECT_ID}/collections Bearer ${TOKEN} ${PROJECT_ID}`,
    ])
  })

  it("comes from --project, then NOHEAD_PROJECT, then the profile's default", async () => {
    const t = signedIn({ routes })
    await t.ok(["--project", OTHER, "records", "list", "posts"])
    t.runtime.env = { HOME, NOHEAD_PROJECT: OTHER }
    await t.ok(["collections", "list"])

    expect(sent(t)).toEqual([
      `/v1/collections/posts/records Bearer ${TOKEN} ${OTHER}`,
      `/v1/projects/${OTHER}/collections Bearer ${TOKEN} ${OTHER}`,
    ])
  })

  it("must be chosen: without one, a project's command says how", async () => {
    for (const argv of [
      ["records", "list", "posts"],
      ["collections", "list"],
    ]) {
      const t = signedIn({ project_id: null, routes })
      expect(await run(argv, t.runtime)).toBe(ExitCode.Usage)
      expect(t.err()).toContain(
        "No project chosen. Run `nohead use <project>` to choose a default"
      )
      expect(t.requests).toHaveLength(0)
    }
  })

  it("is never named for an API key, which works in its own project", async () => {
    const t = testRuntime({
      routes: {
        "GET /v1/me": () => contractResponse("me_get", ME),
        ...routes,
      },
    })
    await t.ok(["records", "list", "posts"])
    await t.ok(["collections", "list"])
    expect(t.requests.map((r) => r.headers.get("Nohead-Project"))).toEqual([
      null,
      null,
      null,
    ])
  })
})

describe("whoami with a CLI session", () => {
  const me = () => contractResponse("me_get", PERSON)

  it("shows the person, the API and the project, naming no project to the API", async () => {
    const t = signedIn({ routes: { "GET /v1/me": me } })

    await t.ok(["whoami"])

    expect(t.out()).toBe(
      [
        "user:      Ada Lovelace",
        "email:     ada@example.com",
        "signed in: CLI session (acts as you)",
        "api:       http://api.test",
        `project:   ${PROJECT_ID}`,
        "from:      profile default",
        "",
      ].join("\n")
    )
    expect(t.requests[0].headers.get("Nohead-Project")).toBeNull()
  })

  it("works without a project, and prints JSON with --json", async () => {
    const t = signedIn({ project_id: null, routes: { "GET /v1/me": me } })

    await t.ok(["whoami"])
    expect(t.out()).toContain(
      "project:   none (choose one: nohead use <project>)"
    )

    await t.ok(["--json", "whoami"])
    expect(JSON.parse(t.out().slice(t.out().indexOf("{")))).toEqual({
      ...PERSON,
      api_url: "http://api.test",
      project_id: null,
    })
  })
})

describe("projects list", () => {
  it("lists the person's projects, marking the one commands use", async () => {
    const t = signedIn({
      routes: { "GET /v1/projects": projects([BLOG, DOCS]) },
    })

    await t.ok(["projects", "list"])

    expect(t.out()).toBe(
      [
        "   ID                              NAME  SLUG  ORGANIZATION",
        `-  ${"-".repeat(30)}  ----  ----  ${"-".repeat(30)}`,
        `*  ${PROJECT_ID}  Blog  blog  ${ORG}`,
        `   ${OTHER}  Docs  docs  ${ORG}`,
        "",
      ].join("\n")
    )
    expect(t.requests[0].headers.get("Authorization")).toBe(`Bearer ${TOKEN}`)
    expect(t.requests[0].headers.get("Nohead-Project")).toBeNull()
    expect(new URL(t.requests[0].url).search).toBe("?limit=100")
  })

  it("pages like other lists, and prints the API's pages with --json", async () => {
    const one = signedIn({
      routes: { "GET /v1/projects": projects([BLOG], [DOCS]) },
    })
    await one.ok(["projects", "list"])
    expect(one.out()).toContain("More: --cursor 1")

    const all = signedIn({
      routes: { "GET /v1/projects": projects([BLOG], [DOCS]) },
    })
    await all.ok(["--json", "projects", "list", "--all"])
    expect(all.json()).toEqual({ data: [BLOG, DOCS] })

    const json = signedIn({
      routes: { "GET /v1/projects": projects([BLOG], [DOCS]) },
    })
    await json.ok(["--json", "projects", "list", "--limit", "1"])
    expect(json.json()).toEqual(page([BLOG], "1"))
    expect(new URL(json.requests[0].url).search).toBe("?limit=1")
  })

  it("is for a CLI session: an API key belongs to one project", async () => {
    const t = testRuntime()
    expect(await run(["projects", "list"], t.runtime)).toBe(ExitCode.Usage)
    expect(t.err()).toContain("An API key belongs to one project")
    expect(t.requests).toHaveLength(0)
  })

  it("says to log in first when there are no credentials", async () => {
    const t = testRuntime({ env: { HOME } })
    expect(await run(["projects", "list"], t.runtime)).toBe(ExitCode.Usage)
    expect(t.err()).toContain("Not logged in")
  })

  it("asks again when the API is briefly unavailable, as the SDK does", async () => {
    let calls = 0
    const t = signedIn({
      routes: {
        "GET /v1/projects": () =>
          ++calls === 1
            ? Response.json(
                {
                  error: {
                    type: "service_unavailable",
                    message: "Try again shortly",
                  },
                },
                { status: 503 }
              )
            : Response.json({
                data: [],
                meta: { next_cursor: null, has_more: false },
              }),
      },
    })
    await t.ok(["projects", "list"])
    expect(calls).toBe(2)
  })

  it("shows the API's errors as they are", async () => {
    const t = signedIn({
      routes: {
        "GET /v1/projects": () =>
          Response.json(
            {
              error: {
                type: "authentication_error",
                message: "The CLI session has ended",
              },
            },
            { status: 401 }
          ),
      },
    })
    expect(await run(["projects", "list"], t.runtime)).toBe(ExitCode.ApiError)
    expect(t.err()).toContain("Error: The CLI session has ended")
  })
})

describe("use", () => {
  const saved = (t: ReturnType<typeof signedIn>) =>
    JSON.parse(t.text(CONFIG)).profiles.default

  it("sets the profile's default project by ID or slug", async () => {
    const byId = signedIn({
      routes: { "GET /v1/projects": projects([BLOG], [DOCS]) },
    })
    await byId.ok(["use", OTHER])
    expect(saved(byId)).toEqual({
      api_url: "http://api.test",
      token: TOKEN,
      project_id: OTHER,
    })
    expect(byId.out()).toBe(
      [
        `Default project: Docs (${OTHER}).`,
        'Saved in profile "default".',
        "",
      ].join("\n")
    )

    const bySlug = signedIn({
      project_id: null,
      routes: { "GET /v1/projects": projects([BLOG, DOCS]) },
    })
    await bySlug.ok(["--json", "use", "docs"])
    expect(saved(bySlug).project_id).toBe(OTHER)
    expect(bySlug.json()).toEqual({ profile: "default", project: DOCS })
  })

  it("refuses a slug two organizations use, listing the IDs", async () => {
    const twin = project(OTHER, "Blog", "blog", ORG_B)
    const t = signedIn({
      routes: { "GET /v1/projects": projects([BLOG, twin]) },
    })
    expect(await run(["use", "blog"], t.runtime)).toBe(ExitCode.Usage)
    expect(t.err()).toContain(
      `More than one of your projects has the slug "blog": use its ID (${PROJECT_ID} in ${ORG}, ${OTHER} in ${ORG_B})`
    )
    expect(t.written).toEqual({})
  })

  it("refuses a project the person doesn't have", async () => {
    const t = signedIn({ routes: { "GET /v1/projects": projects([BLOG]) } })
    expect(await run(["use", "nope"], t.runtime)).toBe(ExitCode.ApiError)
    expect(t.err()).toContain('None of your projects has the ID or slug "nope"')
    expect(t.written).toEqual({})
  })

  it("says when --project or NOHEAD_PROJECT still wins", async () => {
    const t = signedIn({
      env: { NOHEAD_PROJECT: PROJECT_ID },
      routes: { "GET /v1/projects": projects([BLOG, DOCS]) },
    })
    await t.ok(["use", "docs"])
    expect(t.err()).toContain(
      "NOHEAD_PROJECT is set, so commands use that project rather than this one."
    )
  })

  it("is for a CLI session: an API key belongs to one project", async () => {
    const t = testRuntime()
    expect(await run(["use", "blog"], t.runtime)).toBe(ExitCode.Usage)
    expect(t.err()).toContain("An API key belongs to one project")
    expect(t.requests).toHaveLength(0)
  })

  it("leaves the profile alone when the session comes from NOHEAD_API_KEY", async () => {
    const t = signedIn({ env: { NOHEAD_API_KEY: TOKEN } })
    expect(await run(["use", "blog"], t.runtime)).toBe(ExitCode.Usage)
    expect(t.err()).toContain("set NOHEAD_PROJECT, or pass --project, instead")
    expect(t.requests).toHaveLength(0)
  })
})
