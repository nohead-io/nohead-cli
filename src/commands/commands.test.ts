import { describe, expect, it } from "vitest"

import { run } from "../cli.ts"
import { ExitCode } from "../errors.ts"
import { contractResponse } from "../test/contract.ts"
import {
  ME,
  NOW,
  PROJECT_ID,
  REC_A,
  REC_B,
  asset,
  collection,
  COLLECTION_ID,
  DRF_A,
  draft,
  field,
  record,
  revision,
} from "../test/fixtures.ts"
import {
  fakeTimeouts,
  raw,
  testRuntime,
  withoutWaiting,
  type Handler,
} from "../test/runtime.ts"
import { fromYaml, toYaml, type CollectionSpec } from "../schema/format.ts"

const page = <T>(data: T[], next_cursor: string | null = null) => ({
  data,
  meta: { next_cursor, has_more: next_cursor !== null },
})
const me = () => contractResponse("me_get", ME)
const body = async (request: Request) => JSON.parse(await request.text())
const validation = (message: string, field: string, code: string) => ({
  error: {
    type: "validation_error",
    message,
    request_id: "req_01J9ZQ3F8X5W2K7M4N6P0R1S2T",
    details: [{ field, code, message: code }],
  },
})

describe("credentials and project", () => {
  it("shows the API key in use", async () => {
    const t = testRuntime({ routes: { "GET /v1/me": me } })

    await t.ok(["whoami"])
    expect(t.out()).toContain(`project: ${PROJECT_ID}`)
    expect(t.out()).toContain("scopes:  records:read")
  })

  it("finds the project from the API key, or uses --project", async () => {
    const list = () =>
      contractResponse("collections_list", page([collection()]))
    const discovered = testRuntime({
      routes: {
        "GET /v1/me": me,
        [`GET /v1/projects/${PROJECT_ID}/collections`]: list,
      },
    })
    await discovered.ok(["collections", "list"])
    expect(discovered.requests.map((r) => new URL(r.url).pathname)).toEqual([
      "/v1/me",
      `/v1/projects/${PROJECT_ID}/collections`,
    ])

    const explicit = testRuntime({
      routes: { [`GET /v1/projects/prj_other/collections`]: list },
    })
    await explicit.ok(["--project", "prj_other", "collections", "list"])
    expect(explicit.requests).toHaveLength(1)
  })

  it("explains a missing API key as a usage error", async () => {
    const t = testRuntime({ env: { NOHEAD_API_URL: "http://api.test" } })

    expect(await run(["records", "get", REC_A], t.runtime)).toBe(ExitCode.Usage)
    expect(t.err()).toContain("Not logged in. Run `nohead login`")
    expect(t.requests).toHaveLength(0)
  })
})

describe("collections", () => {
  it("lists collections as a table", async () => {
    const t = testRuntime({
      routes: {
        "GET /v1/me": me,
        [`GET /v1/projects/${PROJECT_ID}/collections`]: () =>
          contractResponse("collections_list", page([collection()])),
      },
    })

    await t.ok(["collections", "list"])
    expect(t.out()).toMatch(/SLUG\s+NAME\s+FIELDS\s+SCHEMA\s+ID/)
    expect(t.out()).toMatch(/posts\s+Posts\s+1\s+v2/)
  })

  it("creates a collection with attribution headers", async () => {
    const t = testRuntime({
      routes: {
        "GET /v1/me": me,
        [`POST /v1/projects/${PROJECT_ID}/collections`]: () =>
          contractResponse(
            "collections_create",
            collection({ slug: "blog-posts", name: "Blog posts" }),
            { status: 201 }
          ),
      },
    })

    await t.ok(["--note", "New model", "collections", "create", "blog-posts"])
    const create = t.requests[1]
    expect(await body(create)).toEqual({
      slug: "blog-posts",
      name: "Blog posts",
    })
    expect(create.headers.get("Nohead-Client")).toMatch(/^cli\//)
    // Percent-encoded (UTF-8), so a note in any language fits in a header.
    expect(create.headers.get("Nohead-Change-Note")).toBe("New%20model")
    expect(create.headers.get("Authorization")).toBe(
      "Bearer nohead_sk_test0000000_secret"
    )
  })

  it("creates a collection included in public search", async () => {
    const t = testRuntime({
      routes: {
        "GET /v1/me": me,
        [`POST /v1/projects/${PROJECT_ID}/collections`]: () =>
          contractResponse(
            "collections_create",
            collection({ public_search: true }),
            { status: 201 }
          ),
      },
    })

    await t.ok(["collections", "create", "posts", "--public-search"])
    expect(await body(t.requests[1])).toEqual({
      slug: "posts",
      name: "Posts",
      public_search: true,
    })
  })

  it("requires --yes to delete", async () => {
    const refused = testRuntime()
    expect(await run(["collections", "delete", "posts"], refused.runtime)).toBe(
      ExitCode.Usage
    )
    expect(refused.requests).toHaveLength(0)

    const t = testRuntime({
      routes: {
        "DELETE /v1/collections/posts": () =>
          contractResponse(
            "collections_delete",
            collection({ deleted_at: NOW, purge_after: NOW })
          ),
      },
    })
    await t.ok(["collections", "delete", "posts", "--yes"])
    expect(t.out()).toContain("Restore it with: nohead collections restore")
  })
})

describe("fields", () => {
  it("adds a field with a derived API key, dashed type names and a relation target", async () => {
    const t = testRuntime({
      routes: {
        "GET /v1/collections/authors": () =>
          contractResponse(
            "collections_get",
            collection({
              id: "col_01J9ZQ3F8X5W2K7M4N6P0AUTHR",
              slug: "authors",
            })
          ),
        "POST /v1/collections/posts/fields": () =>
          contractResponse(
            "fields_create",
            field({
              key: "lead_author",
              type: "relation",
              configuration: {
                target_collection_id: "col_01J9ZQ3F8X5W2K7M4N6P0AUTHR",
              },
            }),
            { status: 201 }
          ),
      },
    })

    await t.ok([
      "fields",
      "add",
      "posts",
      "Lead Author",
      "--type",
      "relation",
      "--target",
      "authors",
      "--required",
    ])
    expect(await body(t.requests[1])).toEqual({
      name: "Lead Author",
      key: "lead_author",
      type: "relation",
      required: true,
      multiple: false,
      configuration: { target_collection_id: "col_01J9ZQ3F8X5W2K7M4N6P0AUTHR" },
    })

    const rich = testRuntime({
      routes: {
        "POST /v1/collections/posts/fields": () =>
          contractResponse(
            "fields_create",
            field({ key: "body", type: "rich_text" }),
            { status: 201 }
          ),
      },
    })
    await rich.ok(["fields", "add", "posts", "body", "--type", "rich-text"])
    expect((await body(rich.requests[0])).type).toBe("rich_text")
  })

  it("rejects unknown field types and numbers before calling the API", async () => {
    for (const [args, message] of [
      [["add", "posts", "size", "--type", "float"], "Unknown field type"],
      [["migrate", "posts", "size", "--type", "float"], "Unknown field type"],
      [["update", "posts", "size", "--max", "ten"], "--max must be a number"],
    ] as const) {
      const t = testRuntime()
      expect(await run(["fields", ...args], t.runtime), args.join(" ")).toBe(
        ExitCode.Usage
      )
      expect(t.err()).toContain(message)
      expect(t.requests).toHaveLength(0)
    }
  })

  it("updates a field by API key, merging configuration", async () => {
    const title = field({
      key: "title",
      configuration: { description: "Shown in lists" },
    })
    const t = testRuntime({
      routes: {
        "GET /v1/collections/posts/fields": () =>
          contractResponse("fields_list", page([title])),
        [`PATCH /v1/fields/${title.id}`]: () =>
          contractResponse("fields_update", { ...title, name: "Headline" }),
      },
    })

    await t.ok([
      "fields",
      "update",
      "posts",
      "title",
      "--name",
      "Headline",
      "--max-length",
      "80",
      "--required",
    ])
    expect(await body(t.requests[1])).toEqual({
      name: "Headline",
      required: true,
      configuration: { description: "Shown in lists", max_length: 80 },
    })
  })

  it("turns a format on with its own lengths, and off with --no-format", async () => {
    const handle = field({
      key: "handle",
      configuration: { max_length: 40 },
    })
    const t = testRuntime({
      routes: {
        "GET /v1/collections/posts/fields": () =>
          contractResponse("fields_list", page([handle])),
        [`PATCH /v1/fields/${handle.id}`]: () =>
          contractResponse("fields_update", handle),
      },
    })

    await t.ok(["fields", "update", "posts", "handle", "--format", "email"])
    expect(await body(t.requests[1])).toEqual({
      configuration: { format: "email" },
    })

    const email = {
      ...handle,
      configuration: { format: "email", unique: true },
    }
    const u = testRuntime({
      routes: {
        "GET /v1/collections/posts/fields": () =>
          contractResponse("fields_list", page([email])),
        [`PATCH /v1/fields/${handle.id}`]: () =>
          contractResponse("fields_update", handle),
      },
    })
    await u.ok(["fields", "update", "posts", "handle", "--no-format"])
    expect(await body(u.requests[1])).toEqual({
      configuration: { unique: true },
    })
  })

  it("adds a date field with a time zone, and removes its time reading days in a chosen zone", async () => {
    const starts = field({
      key: "starts",
      type: "date",
      configuration: {
        include_time: true,
        time_zone: "Europe/Copenhagen",
        description: "Doors open",
      },
    })
    const t = testRuntime({
      routes: {
        "POST /v1/collections/events/fields": () =>
          contractResponse("fields_create", starts, { status: 201 }),
        "GET /v1/collections/events/fields": () =>
          contractResponse("fields_list", page([starts])),
        [`POST /v1/collections/${starts.collection_id}/migrations`]: () =>
          contractResponse("migrations_create", {
            object: "field_migration_preview",
            field_id: starts.id,
            from: {
              type: "date",
              configuration: starts.configuration,
              multiple: false,
              required: false,
            },
            to: {
              type: "date",
              configuration: { description: "Doors open" },
              multiple: false,
              required: false,
            },
            conversion: "conditional",
            records: {
              total: 1,
              unchanged: 0,
              converted: 1,
              backfilled: 0,
              cleared: 0,
              invalid: 0,
            },
            samples: [],
          }),
      },
    })

    await t.ok([
      "fields",
      "add",
      "events",
      "Starts",
      "--type",
      "date",
      "--include-time",
      "--time-zone",
      "Europe/Copenhagen",
    ])
    expect(await body(t.requests[0])).toEqual({
      name: "Starts",
      key: "starts",
      type: "date",
      required: false,
      multiple: false,
      configuration: { include_time: true, time_zone: "Europe/Copenhagen" },
    })

    await t.ok([
      "fields",
      "migrate",
      "events",
      "starts",
      "--no-include-time",
      "--days-in",
      "America/New_York",
      "--dry-run",
    ])
    expect(await body(t.requests[2])).toEqual({
      field_id: starts.id,
      configuration: { description: "Doors open" },
      time_zone: "America/New_York",
      on_invalid: "fail",
    })
  })

  it("adds a unique slug field", async () => {
    const slug = field({
      key: "slug",
      type: "text",
      configuration: { format: "slug", unique: true },
    })
    const t = testRuntime({
      routes: {
        "POST /v1/collections/posts/fields": () =>
          contractResponse("fields_create", slug, { status: 201 }),
      },
    })

    await t.ok([
      "fields",
      "add",
      "posts",
      "Slug",
      "--type",
      "text",
      "--format",
      "slug",
      "--unique",
    ])
    expect(await body(t.requests[0])).toEqual({
      name: "Slug",
      key: "slug",
      type: "text",
      required: false,
      multiple: false,
      configuration: { format: "slug", unique: true },
    })
  })

  it("restores deleted fields by API key", async () => {
    const legacy = field({
      key: "legacy",
      deleted_at: NOW,
      purge_after: NOW,
    })
    const t = testRuntime({
      routes: {
        "GET /v1/collections/posts/fields": (request) => {
          expect(new URL(request.url).searchParams.get("filter[deleted]")).toBe(
            "true"
          )
          return contractResponse("fields_list", page([legacy]))
        },
        [`POST /v1/fields/${legacy.id}/restore`]: () =>
          contractResponse("fields_restore", {
            ...legacy,
            deleted_at: null,
            purge_after: null,
          }),
      },
    })

    await t.ok(["fields", "restore", "posts", "legacy"])
  })

  it("finds a field by API key on a later page, reading no further", async () => {
    const title = field({ key: "title" })
    const others = Array.from({ length: 100 }, (_, i) =>
      field({
        key: `other_${i}`,
        id: `fld_01J9ZQ3F8X5W2K7M4N6P${String(i).padStart(4, "0")}`,
      })
    )
    const t = testRuntime({
      routes: {
        "GET /v1/collections/posts/fields": (request) => {
          const cursor = new URL(request.url).searchParams.get("cursor")
          if (cursor === "page-3") throw new Error("read past the field")
          return contractResponse(
            "fields_list",
            cursor === "page-2"
              ? page([title], "page-3")
              : page(others, "page-2")
          )
        },
        [`PATCH /v1/fields/${title.id}`]: () =>
          contractResponse("fields_update", { ...title, name: "Headline" }),
      },
    })

    await t.ok(["fields", "update", "posts", "title", "--name", "Headline"])
    expect(
      t.requests.map((r) => {
        const url = new URL(r.url)
        return `${r.method} ${url.pathname} ${url.searchParams.get("cursor")}`
      })
    ).toEqual([
      "GET /v1/collections/posts/fields null",
      "GET /v1/collections/posts/fields page-2",
      `PATCH /v1/fields/${title.id} null`,
    ])
  })

  it("names a field no page has", async () => {
    const t = testRuntime({
      routes: {
        "GET /v1/collections/posts/fields": (request) =>
          contractResponse(
            "fields_list",
            new URL(request.url).searchParams.get("cursor")
              ? page([field({ key: "body" })])
              : page([field({ key: "summary" })], "page-2")
          ),
      },
    })

    expect(await run(["fields", "delete", "posts", "title"], t.runtime)).toBe(
      ExitCode.Usage
    )
    expect(t.err()).toContain('No field "title" in posts')
    expect(t.requests).toHaveLength(2)
  })
})

describe("records", () => {
  it("shows a record, and no schedule when it has none", async () => {
    const t = testRuntime({
      routes: {
        [`GET /v1/records/${REC_A}`]: () =>
          contractResponse(
            "records_get",
            record(REC_A, { title: "Hello" }, { published_at: NOW })
          ),
        [`GET /v1/records/${REC_A}/schedule`]: () =>
          contractResponse(
            "records_get_schedule",
            {
              error: {
                type: "not_found",
                message: "The record has no schedule",
                request_id: "req_1",
                details: [
                  { code: "not_scheduled", message: "set one with PUT" },
                ],
              },
            },
            { status: 404 }
          ),
      },
    })

    await t.ok(["records", "get", REC_A])
    expect(t.out()).toMatch(/status:\s+published/)
    expect(t.out()).toMatch(/title:\s+Hello/)
    expect(t.out()).not.toContain("publishes at")
  })

  it("shows a record to a published-only key, which can't read schedules", async () => {
    const t = testRuntime({
      routes: {
        [`GET /v1/records/${REC_A}`]: () =>
          contractResponse(
            "records_get",
            record(REC_A, { title: "Hello" }, { published_at: NOW })
          ),
        [`GET /v1/records/${REC_A}/schedule`]: () =>
          contractResponse(
            "records_get_schedule",
            {
              error: {
                type: "authorization_error",
                message: "Published-only API keys cannot read schedules",
                request_id: "req_1",
              },
            },
            { status: 403 }
          ),
      },
    })

    await t.ok(["records", "get", REC_A])
    expect(t.out()).toMatch(/title:\s+Hello/)
  })

  it("schedules a record that has no schedule yet", async () => {
    const t = testRuntime({
      routes: {
        [`GET /v1/records/${REC_A}/schedule`]: () =>
          contractResponse(
            "records_get_schedule",
            {
              error: {
                type: "not_found",
                message: "The record has no schedule",
                request_id: "req_1",
                details: [
                  { code: "not_scheduled", message: "set one with PUT" },
                ],
              },
            },
            { status: 404 }
          ),
        [`PUT /v1/records/${REC_A}/schedule`]: async (request) =>
          contractResponse("records_schedule", {
            object: "schedule",
            record_id: REC_A,
            last_error: null,
            ...(await body(request)),
          }),
      },
    })

    await t.ok(["records", "schedule", REC_A, "--publish-at", "+1h"])
    expect(await body(t.requests[1])).toEqual({
      publish_at: "2026-09-27T13:00:00.000Z",
      unpublish_at: null,
    })
  })

  it("schedules a publish (ISO or relative times) and cancels it", async () => {
    const scheduled = {
      object: "schedule" as const,
      record_id: REC_A,
      publish_at: "2026-09-27T14:00:00.000Z",
      unpublish_at: "2026-10-01T09:00:00.000Z",
      last_error: null,
    }
    const none = { ...scheduled, publish_at: null, unpublish_at: null }
    const t = testRuntime({
      routes: {
        [`GET /v1/records/${REC_A}/schedule`]: () =>
          contractResponse("records_get_schedule", scheduled),
        [`PUT /v1/records/${REC_A}/schedule`]: () =>
          contractResponse("records_schedule", scheduled),
        [`DELETE /v1/records/${REC_A}/schedule`]: () =>
          contractResponse("records_unschedule", none),
      },
    })

    await t.ok([
      "records",
      "schedule",
      REC_A,
      "--publish-at",
      "+2h",
      "--unpublish-at",
      "2026-10-01T11:00:00+02:00",
    ])
    expect(await body(t.requests[0])).toEqual({
      publish_at: "2026-09-27T14:00:00.000Z", // the test clock is 12:00 UTC
      unpublish_at: "2026-10-01T09:00:00.000Z",
    })
    expect(t.out()).toContain(
      "publishes at 2026-09-27T14:00:00.000Z, unpublishes at 2026-10-01T09:00:00.000Z"
    )

    await t.ok(["records", "schedule", REC_A, "--unpublish-at", "none"])
    // The API replaces the whole schedule: the time left out keeps its value.
    expect(t.requests[1].method).toBe("GET")
    expect(await body(t.requests[2])).toEqual({
      publish_at: "2026-09-27T14:00:00.000Z",
      unpublish_at: null,
    })

    await t.ok(["records", "unschedule", REC_A])
    expect(t.requests[3].method).toBe("DELETE")
  })

  it("lists the collection's scheduled changes, soonest first", async () => {
    const t = testRuntime({
      routes: {
        "GET /v1/collections/posts/scheduled-changes": () =>
          contractResponse("scheduled_changes_list", {
            data: [
              {
                object: "scheduled_change",
                action: "publish",
                at: "2026-09-28T09:00:00.000Z",
                record_id: REC_A,
                draft_id: null,
              },
              {
                object: "scheduled_change",
                action: "merge",
                at: "2026-09-29T09:00:00.000Z",
                record_id: REC_B,
                draft_id: DRF_A,
              },
            ],
            meta: { next_cursor: null, has_more: false },
          }),
      },
    })

    await t.ok(["records", "scheduled", "posts"])
    expect(new URL(t.requests[0].url).searchParams.get("limit")).toBe("100")
    expect(t.out()).toMatch(
      new RegExp(`2026-09-28T09:00:00.000Z\\s+publish\\s+${REC_A}`)
    )
    expect(t.out()).toMatch(new RegExp(`merge\\s+${REC_B}\\s+${DRF_A}`))
  })

  it("says when nothing is scheduled, latest first with --sort -at", async () => {
    const t = testRuntime({
      routes: {
        "GET /v1/collections/posts/scheduled-changes": () =>
          contractResponse("scheduled_changes_list", {
            data: [],
            meta: { next_cursor: null, has_more: false },
          }),
      },
    })

    await t.ok(["records", "scheduled", "posts", "--all", "--sort", "-at"])
    expect(new URL(t.requests[0].url).searchParams.get("sort")).toBe("-at")
    expect(t.out().trim()).toBe("Nothing is scheduled.")
    expect(
      await run(["records", "scheduled", "posts", "--sort", "soon"], t.runtime)
    ).toBe(ExitCode.Usage)
  })

  it("refuses unclear schedule times before calling the API", async () => {
    const t = testRuntime({ routes: {} })

    expect(await run(["records", "schedule", REC_A], t.runtime)).toBe(
      ExitCode.Usage
    )
    expect(
      await run(
        ["records", "schedule", REC_A, "--publish-at", "tomorrow 9am"],
        t.runtime
      )
    ).toBe(ExitCode.Usage)
    expect(
      await run(
        ["records", "schedule", REC_A, "--publish-at", "2026-10-01T09:00"],
        t.runtime
      )
    ).toBe(ExitCode.Usage) // no time zone
    expect(t.err()).toContain("must be an ISO 8601 time with a time zone")
    expect(t.requests).toHaveLength(0)
  })

  it("creates records from --set, --data-file and stdin", async () => {
    const created = () =>
      contractResponse("records_create", record(REC_A, { title: "Hello" }), {
        status: 201,
      })
    const t = testRuntime({
      routes: { "POST /v1/collections/posts/records": created },
      files: { "post.json": '{"title": "From file", "tags": ["a"]}' },
    })

    await t.ok([
      "records",
      "create",
      "posts",
      "--data-file",
      "post.json",
      "--set",
      "title=Override",
    ])
    expect(await body(t.requests[0])).toEqual({
      data: { title: "Override", tags: ["a"] },
    })

    const piped = testRuntime({
      routes: { "POST /v1/collections/posts/records": created },
      stdin: '{"title": "Piped"}',
    })
    await piped.ok(["records", "create", "posts", "--data-file", "-"])
    expect(await body(piped.requests[0])).toEqual({ data: { title: "Piped" } })
  })

  it("rejects malformed input as usage errors", async () => {
    for (const args of [
      ["records", "create", "posts"],
      ["records", "create", "posts", "--set", "views:=three"],
      ["records", "create", "posts", "--set", "novalue"],
      ["records", "create", "posts", "--data", "[1]"],
      ["records", "create", "posts", "--data-file", "missing.json"],
    ]) {
      const t = testRuntime()
      expect(await run(args, t.runtime), args.join(" ")).toBe(ExitCode.Usage)
      expect(t.requests).toHaveLength(0)
    }
  })

  it("updates the --set fields, sending If-Match with --if-revision", async () => {
    const t = testRuntime({
      routes: {
        [`PATCH /v1/records/${REC_A}`]: () =>
          contractResponse("records_update", record(REC_A, { title: "Mine" })),
      },
    })

    await t.ok([
      "records",
      "update",
      REC_A,
      "--set",
      "title=Mine",
      "--if-revision",
      "1",
    ])
    expect(await body(t.requests[0])).toEqual({ data: { title: "Mine" } })
    expect(t.requests[0].headers.get("If-Match")).toBe('"1"')
  })

  it("follows cursors with --all and passes filters", async () => {
    const t = testRuntime({
      routes: {
        "GET /v1/collections/posts/records": (request) =>
          new URL(request.url).searchParams.get("cursor")
            ? contractResponse(
                "records_list",
                page([record(REC_B, { title: "Two" })])
              )
            : contractResponse(
                "records_list",
                page([record(REC_A, { title: "One" })], "next-page")
              ),
      },
    })

    await t.ok([
      "--json",
      "records",
      "list",
      "posts",
      "--all",
      "--status",
      "published",
      "--filter",
      "category=news",
      "--filter",
      "price<50",
      "--sort",
      "-price",
    ])
    expect(t.json().data.map((r: { id: string }) => r.id)).toEqual([
      REC_A,
      REC_B,
    ])
    const [first, second] = t.requests.map((r) =>
      Object.fromEntries(new URL(r.url).searchParams)
    )
    expect(first).toEqual({
      "filter[published_at][exists]": "true",
      "filter[category]": "news",
      "filter[price][lt]": "50",
      sort: "-price",
      limit: "100",
    })
    expect(second).toEqual({ ...first, cursor: "next-page" })
    expect(t.requests).toHaveLength(2)
  })

  it("refuses an unknown --status before calling the API", async () => {
    const t = testRuntime()

    expect(
      await run(
        ["--json", "records", "list", "posts", "--status", "draft"],
        t.runtime
      )
    ).toBe(ExitCode.Usage)
    expect(JSON.parse(t.err()).error.message).toBe(
      "option '--status <status>' argument 'draft' is invalid. Allowed choices are published, unpublished."
    )
    expect(t.requests).toHaveLength(0)
  })

  it("writes no export when a later page fails", async () => {
    const t = testRuntime({
      routes: {
        "GET /v1/collections/posts/records": (request) =>
          new URL(request.url).searchParams.get("cursor")
            ? contractResponse(
                "records_list",
                {
                  error: {
                    type: "invalid_request",
                    message: "The cursor has expired",
                    request_id: "req_01J9ZQ3F8X5W2K7M4N6P0R1S2T",
                  },
                },
                { status: 400 }
              )
            : contractResponse(
                "records_list",
                page([record(REC_A, { title: "One" })], "next-page")
              ),
      },
    })

    expect(
      await run(
        ["records", "export", "posts", "--output", "backup.jsonl"],
        t.runtime
      )
    ).toBe(ExitCode.ApiError)
    expect(t.requests).toHaveLength(2)
    expect(t.err()).toContain("The cursor has expired")
    expect(t.written).toEqual({})
  })

  it("shows history and diffs", async () => {
    const t = testRuntime({
      routes: {
        [`GET /v1/records/${REC_A}/revisions`]: () =>
          contractResponse(
            "record_revisions_list",
            page([revision(2, { note: "Fix typo" }), revision(1)])
          ),
        [`GET /v1/records/${REC_A}/diff`]: () =>
          contractResponse("records_diff", {
            object: "record_diff",
            record_id: REC_A,
            from: 1,
            to: 2,
            changes: [
              {
                field: "title",
                field_id: "fld_1",
                field_deleted: false,
                kind: "changed",
                before: "Helo",
                after: "Hello",
              },
            ],
          }),
      },
    })

    await t.ok(["records", "history", REC_A])
    expect(t.out()).toMatch(/2\s+update\s+ci\s+cli\s+title\s+\S+\s+Fix typo/)

    await t.ok(["records", "diff", REC_A, "--from", "1", "--to", "2"])
    expect(t.out()).toContain("title (changed): Helo → Hello")
  })

  it("refuses revision numbers that are not positive integers before calling the API", async () => {
    for (const [args, message] of [
      [["diff", REC_A, "--from", "one", "--to", "2"], "--from"],
      [["revision", REC_A, "0"], "<revision>"],
      [["revert", REC_A, "1.5"], "<revision>"],
      [["publish", REC_A, "--if-revision", ""], "--if-revision"],
    ] as const) {
      const t = testRuntime()
      expect(
        await run(["--json", "records", ...args], t.runtime),
        args.join(" ")
      ).toBe(ExitCode.Usage)
      expect(JSON.parse(t.err()).error).toEqual({
        type: "invalid_request",
        message: `${message} must be a positive integer`,
      })
      expect(t.requests).toHaveLength(0)
    }
  })

  it("pages through history and shows one revision in full", async () => {
    const t = testRuntime({
      routes: {
        [`GET /v1/records/${REC_A}/revisions`]: (request) =>
          new URL(request.url).searchParams.get("cursor") === "next"
            ? contractResponse("record_revisions_list", page([revision(1)]))
            : contractResponse(
                "record_revisions_list",
                page([revision(2)], "next")
              ),
        [`GET /v1/records/${REC_A}/revisions/2`]: () =>
          contractResponse("record_revisions_get", {
            ...revision(2),
            published_at: null,
            data: { title: "Hello" },
            changes: [
              {
                field: "title",
                field_id: "fld_1",
                field_deleted: false,
                kind: "changed",
                before: "Helo",
                after: "Hello",
              },
            ],
          }),
      },
    })

    await t.ok(["records", "history", REC_A, "--limit", "1"])
    expect(new URL(t.requests[0].url).searchParams.get("limit")).toBe("1")
    expect(t.out()).toContain("More: --cursor next")
    await t.ok(["records", "history", REC_A, "--cursor", "next"])
    expect(new URL(t.requests[1].url).searchParams.get("cursor")).toBe("next")

    await t.ok([
      "records",
      "history",
      REC_A,
      "--operation",
      "publish",
      "--actor",
      "usr_1",
      "--since",
      "2026-09-01T00:00:00Z",
    ])
    const filtered = new URL(t.requests[2].url).searchParams
    expect(filtered.get("filter[operation]")).toBe("publish")
    expect(filtered.get("filter[actor_id]")).toBe("usr_1")
    expect(filtered.get("filter[created_at][gte]")).toBe("2026-09-01T00:00:00Z")

    t.requests.length = 0
    await t.ok(["records", "revision", REC_A, "2"])
    expect(t.out()).toMatch(/title:\s+Hello/)
    expect(t.out()).toContain("title (changed): Helo → Hello")
  })

  it("previews and performs reverts", async () => {
    const t = testRuntime({
      routes: {
        [`POST /v1/records/${REC_A}/revisions/1/revert`]: (request) =>
          new URL(request.url).searchParams.get("dry_run") === "true"
            ? contractResponse("record_revisions_revert", {
                object: "revert_preview",
                record_id: REC_A,
                to_revision: 1,
                data: { title: "Helo" },
                changes: [
                  {
                    field: "title",
                    field_id: "fld_1",
                    field_deleted: false,
                    kind: "changed",
                    before: "Hello",
                    after: "Helo",
                  },
                ],
              })
            : contractResponse(
                "record_revisions_revert",
                record(REC_A, { title: "Helo" }, { revision: 3 })
              ),
      },
    })

    await t.ok(["records", "revert", REC_A, "1", "--dry-run"])
    expect(t.out()).toContain(
      "Dry run: reverting to revision 1 would change:\ntitle (changed): Hello → Helo"
    )

    await t.ok(["records", "revert", REC_A, "1"])
    expect(t.out()).toContain(
      `Reverted ${REC_A} to revision 1 (now revision 3)`
    )
  })

  it("exports every record as JSON Lines, keeping stdout pure", async () => {
    const rows = [
      record(REC_A, { title: "One" }),
      record(REC_B, { title: "Two" }),
    ]
    const routes = {
      "GET /v1/collections/posts/records": () =>
        contractResponse("records_list", page(rows)),
    }

    const toStdout = testRuntime({ routes })
    await toStdout.ok(["records", "export", "posts"])
    expect(
      toStdout
        .out()
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l).id)
    ).toEqual([REC_A, REC_B])
    expect(toStdout.err()).toBe("Exported 2 records\n")

    const toFile = testRuntime({ routes })
    await toFile.ok(["records", "export", "posts", "--output", "backup.jsonl"])
    expect(toFile.text("backup.jsonl").trim().split("\n")).toHaveLength(2)
  })

  it("imports JSON Lines, reporting failed lines and exiting 1", async () => {
    const lines = [
      JSON.stringify(
        record(REC_A, { title: "Exported" }, { published_at: NOW })
      ),
      JSON.stringify({ title: "" }),
      "",
      JSON.stringify({ title: "Plain" }),
    ].join("\n")
    const t = testRuntime({
      files: { "in.jsonl": lines },
      routes: {
        "POST /v1/collections/posts/records": async (request) => {
          const { data } = await body(request)
          return data.title
            ? contractResponse("records_create", record(REC_B, data), {
                status: 201,
              })
            : contractResponse(
                "records_create",
                validation("Record validation failed", "title", "required"),
                { status: 422 }
              )
        },
        [`POST /v1/records/${REC_B}/publication`]: () =>
          contractResponse(
            "records_publish",
            record(REC_B, {}, { published_at: NOW })
          ),
      },
    })

    expect(
      await run(
        ["--json", "records", "import", "posts", "in.jsonl", "--publish"],
        t.runtime
      )
    ).toBe(ExitCode.ApiError)
    expect(t.json()).toEqual({
      created: 2,
      failed: [
        {
          line: 2,
          error: expect.objectContaining({ type: "validation_error" }),
        },
      ],
    })
    const paths = t.requests.map(
      (r) => `${r.method} ${new URL(r.url).pathname}`
    )
    expect(paths.filter((p) => p.endsWith("/publication"))).toHaveLength(1)
  })
})

describe("schema push", () => {
  const fieldOrder = {
    object: "field_order",
    collection_id: COLLECTION_ID,
    field_ids: [],
  }
  const title = field({ key: "title", name: "Title", required: true })
  const code = field({ key: "code", name: "Code", position: 1 })
  const headline = field({ key: "headline", name: "Headline" })
  const push = (
    reorder: Handler,
    schema = "title: { type: text, required: true }\n      headline: text\n      code: text",
    routes: Record<string, Handler> = {}
  ) =>
    testRuntime({
      files: {
        "nohead.schema.yaml": `collections:\n  posts:\n    fields:\n      ${schema}\n`,
      },
      routes: {
        ...routes,
        "GET /v1/me": me,
        [`GET /v1/projects/${PROJECT_ID}/collections`]: () =>
          contractResponse(
            "collections_list",
            page([collection({ fields: [title, code] })])
          ),
        [`POST /v1/collections/${COLLECTION_ID}/fields`]: () =>
          contractResponse("fields_create", headline, { status: 201 }),
        [`PUT /v1/collections/${COLLECTION_ID}/field-order`]: reorder,
      },
    })

  it("adds a field between others, then puts every field in the file's order", async () => {
    let order: string[] = []
    const t = push(async (request) => {
      order = (await body(request)).field_ids
      return contractResponse("fields_reorder", fieldOrder)
    })

    await t.ok(["schema", "push", "nohead.schema.yaml", "--yes"])
    expect(order).toEqual([title.id, headline.id, code.id])
  })

  it("reorders a field renamed in the same push by its new key", async () => {
    let order: string[] = []
    const t = push(
      async (request) => {
        order = (await body(request)).field_ids
        return contractResponse("fields_reorder", fieldOrder)
      },
      "code: text\n      headline: { type: text, required: true, renamed_from: title }",
      {
        [`PATCH /v1/fields/${title.id}`]: () =>
          contractResponse("fields_update", {
            ...title,
            key: "headline",
            name: "Headline",
          }),
      }
    )

    await t.ok(["schema", "push", "nohead.schema.yaml", "--yes"])
    expect(order).toEqual([code.id, title.id])
  })

  it("migrates a field into a unique one, checked by the dry run", async () => {
    let sent: Record<string, unknown> = {}
    const definition = {
      type: "text",
      configuration: {},
      multiple: false,
      required: false,
    } as const
    const t = push(
      () => contractResponse("fields_reorder", fieldOrder),
      "title: { type: text, required: true }\n      headline: text\n      code: { type: integer, unique: true }",
      {
        [`POST /v1/collections/${COLLECTION_ID}/migrations`]: async (
          request
        ) => {
          sent = await body(request)
          return contractResponse("migrations_create", {
            object: "field_migration_preview",
            field_id: code.id,
            from: definition,
            to: {
              ...definition,
              type: "integer",
              configuration: { unique: true },
            },
            conversion: "conditional",
            records: {
              total: 1,
              unchanged: 0,
              converted: 0,
              backfilled: 0,
              cleared: 0,
              invalid: 1,
            },
            samples: [],
          })
        },
      }
    )

    expect(
      await run(
        ["schema", "push", "nohead.schema.yaml", "--yes", "--allow-migrations"],
        t.runtime
      )
    ).toBe(ExitCode.ApiError)
    expect(sent).toMatchObject({
      type: "integer",
      configuration: { unique: true },
    })
    expect(t.err()).toContain("cannot be converted")
  })

  it("asks for another push when the fields changed during it", async () => {
    const t = push(() =>
      contractResponse(
        "fields_reorder",
        validation("Fields could not be reordered", "field_ids", "invalid"),
        { status: 422 }
      )
    )

    expect(
      await run(["schema", "push", "nohead.schema.yaml", "--yes"], t.runtime)
    ).toBe(ExitCode.ApiError)
    expect(t.err()).toContain(
      "posts: its fields changed during the push, so they were not put in the file's order. Run the push again."
    )
  })
})

describe("flags", () => {
  it("lists feature flags for the key's context", async () => {
    const t = testRuntime({
      routes: {
        "GET /v1/feature-flags": () =>
          contractResponse("feature_flags_list", {
            object: "feature_flags",
            organization_id: "org_01J9ZQ3F8X5W2K7M4N6P0R1S2T",
            project_id: PROJECT_ID,
            flags: { self_serve_organizations: false },
          }),
      },
    })

    await t.ok(["flags"])
    expect(t.out()).toMatch(/self_serve_organizations\s+no/)
  })
})

describe("field migrations", () => {
  const price = field({ key: "price", type: "text" })
  const fieldsPage = () => contractResponse("fields_list", page([price]))
  const text = {
    type: "text",
    configuration: {},
    multiple: false,
    required: false,
  } as const
  const decimal = { ...text, type: "decimal" } as const
  const counts = (overrides = {}) => ({
    total: 2,
    unchanged: 0,
    converted: 1,
    backfilled: 0,
    cleared: 0,
    invalid: 0,
    ...overrides,
  })
  const migration = (status: string, overrides = {}) => ({
    id: "mig_01J9ZQ3F8X5W2K7M4N6P0R1S2T",
    object: "field_migration",
    collection_id: "col_01J9ZQ3F8X5W2K7M4N6P0R1S2T",
    field_id: price.id,
    status,
    from: text,
    to: decimal,
    backfill: null,
    on_invalid: "fail",
    time_zone: null,
    records: counts(),
    failure: null,
    schema_change_id:
      status === "complete" ? "sch_01J9ZQ3F8X5W2K7M4N6P0R1S2T" : null,
    cancel_requested_at: null,
    actor: {
      type: "api_key",
      id: "key_01J9ZQ3F8X5W2K7M4N6P0R1S2T",
      name: "ci",
    },
    via: "cli",
    note: null,
    request_id: "req_01J9ZQ3F8X5W2K7M4N6P0R1S2T",
    created_at: NOW,
    started_at: status === "pending" ? null : NOW,
    completed_at: ["complete", "failed"].includes(status) ? NOW : null,
    ...overrides,
  })

  it("previews a migration with sample records", async () => {
    const t = testRuntime({
      routes: {
        "GET /v1/collections/products/fields": fieldsPage,
        [`POST /v1/collections/${price.collection_id}/migrations`]: () =>
          contractResponse("migrations_create", {
            object: "field_migration_preview",
            field_id: price.id,
            from: text,
            to: decimal,
            conversion: "conditional",
            records: counts({ invalid: 1, converted: 1 }),
            samples: [
              {
                record_id: REC_A,
                deleted_at: null,
                outcome: "invalid",
                before: "cheap",
                after: null,
                error: { code: "not_convertible", message: "is not a number" },
              },
              {
                record_id: REC_B,
                deleted_at: null,
                outcome: "converted",
                before: "9.5",
                after: 9.5,
                error: null,
              },
            ],
          }),
      },
    })

    await t.ok([
      "fields",
      "migrate",
      "products",
      "price",
      "--type",
      "decimal",
      "--dry-run",
    ])

    const request = t.requests[1]
    expect(new URL(request.url).searchParams.get("dry_run")).toBe("true")
    expect(await body(request)).toEqual({
      field_id: price.id,
      type: "decimal",
      on_invalid: "fail",
    })
    expect(t.out()).toContain("text -> decimal (conditional)")
    expect(t.out()).toContain("2 records: 1 converted, 1 invalid")
    expect(t.out()).toMatch(
      new RegExp(`${REC_A}\\s+invalid\\s+cheap\\s+is not a number`)
    )
    expect(t.out()).toContain("--clear-invalid")
  })

  it("starts a migration with a backfill and waits for it to finish", async () => {
    let polls = 0
    const t = testRuntime({
      routes: {
        "GET /v1/collections/products/fields": fieldsPage,
        [`POST /v1/collections/${price.collection_id}/migrations`]: () =>
          contractResponse("migrations_create", migration("pending"), {
            status: 202,
          }),
        "GET /v1/migrations/mig_01J9ZQ3F8X5W2K7M4N6P0R1S2T": () =>
          contractResponse(
            "migrations_get",
            migration(++polls < 2 ? "running" : "complete")
          ),
      },
    })

    await t.ok([
      "fields",
      "migrate",
      "products",
      "price",
      "--type",
      "decimal",
      "--required",
      "--backfill-json",
      "0",
      "--clear-invalid",
    ])

    expect(await body(t.requests[1])).toEqual({
      field_id: price.id,
      type: "decimal",
      required: true,
      backfill: 0,
      on_invalid: "clear",
    })
    expect(t.err()).toContain("is pending...")
    expect(t.err()).toContain("is running...")
    expect(t.out()).toContain("mig_01J9ZQ3F8X5W2K7M4N6P0R1S2T  complete")
    expect(t.out()).toContain("2 records: 1 converted")
  })

  it("polls soon, then backs off to once a second", async () => {
    let polls = 0
    const sleeps: number[] = []
    const t = testRuntime({
      routes: {
        "GET /v1/migrations/mig_01J9ZQ3F8X5W2K7M4N6P0R1S2T": () =>
          contractResponse(
            "migrations_get",
            migration(++polls < 7 ? "running" : "complete")
          ),
      },
    })
    t.runtime.sleep = async (ms) => void sleeps.push(ms)

    await t.ok([
      "migrations",
      "get",
      "mig_01J9ZQ3F8X5W2K7M4N6P0R1S2T",
      "--wait",
    ])
    expect(sleeps).toEqual([100, 200, 400, 800, 1000, 1000])
  })

  it("exits non-zero when the migration fails", async () => {
    const t = testRuntime({
      routes: {
        "GET /v1/migrations/mig_01J9ZQ3F8X5W2K7M4N6P0R1S2T": () =>
          contractResponse(
            "migrations_get",
            migration("failed", {
              failure: {
                message:
                  "The migration failed unexpectedly; nothing was changed",
              },
            })
          ),
      },
    })

    expect(
      await run(
        ["migrations", "get", "mig_01J9ZQ3F8X5W2K7M4N6P0R1S2T", "--wait"],
        t.runtime
      )
    ).toBe(ExitCode.ApiError)
    expect(t.err()).toContain("nothing was changed")
  })

  it("lists and cancels migrations", async () => {
    const t = testRuntime({
      routes: {
        "GET /v1/collections/products/migrations": () =>
          contractResponse("migrations_list", page([migration("running")])),
        "POST /v1/migrations/mig_01J9ZQ3F8X5W2K7M4N6P0R1S2T/cancel": () =>
          contractResponse(
            "migrations_cancel",
            migration("running", { cancel_requested_at: NOW })
          ),
      },
    })

    await t.ok(["migrations", "list", "products"])
    expect(t.out()).toMatch(
      /mig_01J9ZQ3F8X5W2K7M4N6P0R1S2T\s+running\s+text -> decimal/
    )

    await t.ok(["migrations", "cancel", "mig_01J9ZQ3F8X5W2K7M4N6P0R1S2T"])
    const cancel = t.requests[1]
    expect(`${cancel.method} ${new URL(cancel.url).pathname}`).toBe(
      "POST /v1/migrations/mig_01J9ZQ3F8X5W2K7M4N6P0R1S2T/cancel"
    )
    expect(cancel.headers.get("Idempotency-Key")).toBeTruthy()
    expect(t.out()).toContain("rolls back at its next batch")
  })

  it("pages migrations, following cursors with --all", async () => {
    const api = () =>
      testRuntime({
        routes: {
          "GET /v1/collections/products/migrations": (request) =>
            contractResponse(
              "migrations_list",
              new URL(request.url).searchParams.get("cursor")
                ? page([migration("complete")])
                : page([migration("running")], "next-page")
            ),
        },
      })

    const one = api()
    await one.ok(["migrations", "list", "products"])
    expect(one.out()).toContain("More: --cursor next-page")

    const all = api()
    await all.ok(["--json", "migrations", "list", "products", "--all"])
    expect(all.json().data.map((m: { status: string }) => m.status)).toEqual([
      "running",
      "complete",
    ])
    expect(new URL(all.requests[1].url).searchParams.get("cursor")).toBe(
      "next-page"
    )
  })

  it("rejects contradictory flags", async () => {
    for (const [args, message] of [
      [
        ["migrate", "products", "price", "--multiple", "--single"],
        "option '--single' cannot be used with option '--multiple'",
      ],
      [
        ["migrate", "products", "price", "--required", "--optional"],
        "option '--optional' cannot be used with option '--required'",
      ],
      [
        [
          "migrate",
          "products",
          "price",
          "--backfill",
          "",
          "--backfill-json",
          "0",
        ],
        "option '--backfill-json <json>' cannot be used with option '--backfill <text>'",
      ],
      [
        ["update", "products", "price", "--optional", "--required"],
        "option '--optional' cannot be used with option '--required'",
      ],
    ]) {
      const t = testRuntime()
      expect(await run(["--json", "fields", ...args], t.runtime)).toBe(
        ExitCode.Usage
      )
      expect(JSON.parse(t.err()).error).toEqual({
        type: "invalid_request",
        message,
      })
      expect(t.requests).toHaveLength(0)
    }
  })
})

describe("idempotency", () => {
  const created = () =>
    contractResponse("records_create", record(REC_A, { title: "Hi" }), {
      status: 201,
    })

  it("sends --idempotency-key with mutations", async () => {
    const t = testRuntime({
      routes: { "POST /v1/collections/posts/records": created },
    })

    await t.ok([
      "--idempotency-key",
      "deploy-42",
      "records",
      "create",
      "posts",
      "--set",
      "title=Hi",
    ])

    expect(t.requests[0].headers.get("Idempotency-Key")).toBe("deploy-42")
  })

  it("gives each imported line a key that is the same on every re-run", async () => {
    const file = [
      JSON.stringify({ title: "A" }),
      JSON.stringify({ title: "A" }),
    ].join("\n")
    const keys = async () => {
      const t = testRuntime({
        files: { "in.jsonl": file },
        routes: { "POST /v1/collections/posts/records": created },
      })
      await t.ok(["records", "import", "posts", "in.jsonl"])
      return t.requests.map((r) => r.headers.get("Idempotency-Key"))
    }

    const first = await keys()
    expect(first).toHaveLength(2)
    expect(first[0]).toMatch(/^import-[0-9a-f]{64}:0$/)
    // Identical lines are still separate records.
    expect(first[1]).not.toBe(first[0])
    expect(await keys()).toEqual(first)
  })
})

describe("login and saved keys", () => {
  const env = { HOME: "/home/ada" }
  const configFile = "/home/ada/.config/nohead/config.json"
  const saved = (keys: Record<string, unknown>) => ({
    [configFile]: JSON.stringify({ keys }),
  })
  const config = (t: ReturnType<typeof testRuntime>) =>
    JSON.parse(t.text(configFile))
  // GET /v1/me for another project's key.
  const meOf =
    (project_id: string, name = "ci") =>
    () =>
      contractResponse("me_get", {
        ...ME,
        api_key: { ...ME.api_key, project_id, name },
      })

  it("checks the key from stdin and saves it under its project", async () => {
    const t = testRuntime({
      env: { ...env, NOHEAD_API_URL: "http://api.test" },
      stdin: "nohead_sk_test0000000_secret\n",
      routes: { "GET /v1/me": me },
    })

    await t.ok(["login"])

    expect(t.requests[0].headers.get("Authorization")).toBe(
      "Bearer nohead_sk_test0000000_secret"
    )
    expect(config(t)).toEqual({
      keys: {
        [PROJECT_ID]: {
          api_url: "http://api.test",
          api_key: "nohead_sk_test0000000_secret",
          name: "ci",
        },
      },
    })
    expect(t.out()).toContain(`Saved the key for project ${PROJECT_ID}`)
    expect(t.err()).toBe("")
  })

  it("adds another project's key, and replaces a project's key on a new login", async () => {
    const t = testRuntime({
      env: { ...env, NOHEAD_API_URL: "http://api.test" },
      files: saved({
        [PROJECT_ID]: { api_url: "http://api.test", api_key: "nohead_sk_a" },
      }),
      stdin: "nohead_sk_b\n",
      routes: { "GET /v1/me": meOf("prj_two", "local") },
    })

    await t.ok(["login"])
    expect(Object.keys(config(t).keys)).toEqual([PROJECT_ID, "prj_two"])
    expect(config(t).keys.prj_two).toEqual({
      api_url: "http://api.test",
      api_key: "nohead_sk_b",
      name: "local",
    })
    expect(t.out()).toContain("with API key local (project prj_two)")

    t.runtime.readStdin = async () => "nohead_sk_c\n"
    await t.ok(["login"])
    expect(config(t).keys.prj_two.api_key).toBe("nohead_sk_c")
    expect(config(t).keys[PROJECT_ID].api_key).toBe("nohead_sk_a")
    expect(t.out()).toContain("Replaced the saved key for project prj_two")
  })

  it("refuses a key that is not a project API key", async () => {
    const t = testRuntime({
      env,
      stdin: "nohead_sk_user\n",
      routes: {
        "GET /v1/me": () =>
          contractResponse("me_get", {
            object: "principal",
            type: "user",
            user: {
              id: "usr_1",
              email: "ada@example.com",
              name: "Ada",
              staff: false,
            },
            api_key: null,
          }),
      },
    })

    expect(await run(["login"], t.runtime)).toBe(ExitCode.Usage)
    expect(t.err()).toContain("That is not a project API key")
    expect(t.written).toEqual({})
  })

  // The saved key would be ignored, which would be a surprise.
  it("says NOHEAD_API_KEY wins over the key it saves", async () => {
    const t = testRuntime({
      env: { ...env, NOHEAD_API_KEY: "nohead_sk_env" },
      stdin: "nohead_sk_new\n",
      routes: { "GET /v1/me": me },
    })

    await t.ok(["login"])
    expect(t.requests[0].headers.get("Authorization")).toBe(
      "Bearer nohead_sk_new"
    )
    expect(t.err()).toContain(
      "NOHEAD_API_KEY is set, so commands use it rather than the saved key"
    )
  })

  // Pasted at a terminal, the key must not stay on screen.
  it("reads the key without echo at a terminal, ending on Enter", async () => {
    const t = testRuntime({
      env: { ...env, NOHEAD_API_URL: "http://api.test" },
      routes: { "GET /v1/me": me },
    })
    const prompts: string[] = []
    t.runtime.stdinIsTTY = true
    t.runtime.readStdin = async () => {
      throw new Error("a terminal is read without echo, not as stdin")
    }
    t.runtime.readSecret = async (prompt) => {
      prompts.push(prompt)
      return "nohead_sk_test0000000_secret\n"
    }

    await t.ok(["login"])

    expect(prompts).toEqual([expect.stringContaining("then press Enter")])
    expect(t.requests[0].headers.get("Authorization")).toBe(
      "Bearer nohead_sk_test0000000_secret"
    )
    expect(t.out() + t.err()).not.toContain("nohead_sk_test0000000_secret")
  })

  it("asks for the key without a prompt with --json, so stderr stays empty", async () => {
    const t = testRuntime({ env, routes: { "GET /v1/me": me } })
    t.runtime.stdinIsTTY = true
    const prompts: string[] = []
    t.runtime.readSecret = async (prompt) => {
      prompts.push(prompt)
      return "nohead_sk_test0000000_secret"
    }

    await t.ok(["--json", "login"])
    expect(prompts).toEqual([""])
    expect(t.err()).toBe("")
  })

  it("refuses an empty key typed at a terminal", async () => {
    const t = testRuntime({ env, routes: {} })
    t.runtime.stdinIsTTY = true
    t.runtime.readSecret = async () => "  "

    expect(await run(["login"], t.runtime)).toBe(ExitCode.Usage)
    expect(t.err()).toContain("No API key given")
    expect(t.err()).not.toContain("on stdin")
  })

  it("reads profiles saved by earlier versions as keys by project", async () => {
    const t = testRuntime({
      env: { ...env, NOHEAD_API_URL: "http://api.test" },
      files: {
        [configFile]: JSON.stringify({
          profiles: {
            default: {
              api_url: "http://saved.test",
              api_key: "nohead_sk_saved",
              project_id: PROJECT_ID,
            },
            ci: {
              api_url: "http://api.test",
              api_key: "nohead_sk_ci",
              project_id: "prj_ci",
            },
            // Nothing to save it under.
            old: { api_url: "http://api.test", api_key: "nohead_sk_old" },
          },
        }),
      },
      stdin: "nohead_sk_two\n",
      routes: { "GET /v1/me": meOf("prj_two") },
    })

    await t.ok(["--project", "prj_ci", "whoami"])
    expect(t.requests[0].headers.get("Authorization")).toBe(
      "Bearer nohead_sk_ci"
    )

    // Writing saves the new shape only.
    await t.ok(["login"])
    expect(config(t)).toEqual({
      keys: {
        [PROJECT_ID]: {
          api_url: "http://saved.test",
          api_key: "nohead_sk_saved",
        },
        prj_ci: { api_url: "http://api.test", api_key: "nohead_sk_ci" },
        prj_two: {
          api_url: "http://api.test",
          api_key: "nohead_sk_two",
          name: "ci",
        },
      },
    })
  })

  it("never sends a saved key to another API, or any key over plain http", async () => {
    const elsewhere = testRuntime({
      env: { ...env, NOHEAD_API_URL: "https://attacker.example" },
      files: saved({
        [PROJECT_ID]: {
          api_url: "https://saved.example",
          api_key: "nohead_sk_saved",
        },
      }),
    })
    expect(
      await run(["--project", PROJECT_ID, "whoami"], elsewhere.runtime)
    ).toBe(ExitCode.Usage)
    expect(elsewhere.err()).toContain(
      `The API key saved for project ${PROJECT_ID} is for https://saved.example, not https://attacker.example`
    )
    // Not chosen, the key is not this API's only key either.
    expect(await run(["whoami"], elsewhere.runtime)).toBe(ExitCode.Usage)
    expect(elsewhere.err()).toContain(
      "No API key saved for https://attacker.example"
    )
    expect(elsewhere.requests).toHaveLength(0)

    const insecure = testRuntime({
      env: { ...env, NOHEAD_API_KEY: "nohead_sk_env" },
    })
    expect(
      await run(
        ["--api-url", "http://api.example.com", "whoami"],
        insecure.runtime
      )
    ).toBe(ExitCode.Usage)
    expect(insecure.err()).toContain(
      "Refusing to send an API key to http://api.example.com: use https"
    )
    expect(insecure.requests).toHaveLength(0)
  })

  describe("choosing the project, and with it the key", () => {
    const keys = {
      [PROJECT_ID]: {
        api_url: "http://saved.test",
        api_key: "nohead_sk_saved",
        name: "laptop",
      },
      prj_ci: { api_url: "http://ci.test", api_key: "nohead_sk_ci" },
    }
    const list = () =>
      contractResponse("collections_list", page([collection()]))
    const setup = (
      vars: Record<string, string>,
      options: { files?: Record<string, string>; cwd?: string } = {}
    ) =>
      testRuntime({
        env: { ...env, ...vars },
        files: { ...saved(keys), ...options.files },
        cwd: options.cwd,
        routes: {
          "GET /v1/me": me,
          ...Object.fromEntries(
            [PROJECT_ID, "prj_ci", "prj_env", "prj_flag"].map((id) => [
              `GET /v1/projects/${id}/collections`,
              list,
            ])
          ),
        },
      })
    const linked = (project: string) => JSON.stringify({ project })
    // Where each request went, and with which key.
    const sent = (t: ReturnType<typeof setup>) =>
      t.requests.map((r) => {
        const url = new URL(r.url)
        return `${url.origin}${url.pathname} ${r.headers.get("Authorization")}`
      })

    it("takes --project, then NOHEAD_PROJECT, then nohead.json", async () => {
      const t = setup({}, { files: { "/work/nohead.json": linked("prj_ci") } })
      await t.ok(["collections", "list"])
      t.runtime.env = { ...env, NOHEAD_PROJECT: PROJECT_ID }
      await t.ok(["collections", "list"])
      await t.ok(["--project", "prj_ci", "collections", "list"])
      expect(sent(t)).toEqual([
        "http://ci.test/v1/projects/prj_ci/collections Bearer nohead_sk_ci",
        `http://saved.test/v1/projects/${PROJECT_ID}/collections Bearer nohead_sk_saved`,
        "http://ci.test/v1/projects/prj_ci/collections Bearer nohead_sk_ci",
      ])
    })

    it("finds the nearest nohead.json in a parent folder", async () => {
      const t = setup(
        {},
        {
          cwd: "/work/site/src/pages",
          files: {
            "/work/nohead.json": linked("prj_ci"),
            "/work/site/nohead.json": linked(PROJECT_ID),
          },
        }
      )
      await t.ok(["collections", "list"])
      t.runtime.cwd = () => "/work/docs"
      await t.ok(["collections", "list"])
      expect(sent(t)).toEqual([
        `http://saved.test/v1/projects/${PROJECT_ID}/collections Bearer nohead_sk_saved`,
        "http://ci.test/v1/projects/prj_ci/collections Bearer nohead_sk_ci",
      ])
    })

    it("uses the only saved key, for the API URL when one is set", async () => {
      const only = testRuntime({
        env,
        files: saved({ prj_ci: keys.prj_ci }),
        routes: { "GET /v1/projects/prj_ci/collections": list },
      })
      await only.ok(["collections", "list"])
      expect(sent(only)).toEqual([
        "http://ci.test/v1/projects/prj_ci/collections Bearer nohead_sk_ci",
      ])

      const t = setup({ NOHEAD_API_URL: "http://ci.test" })
      await t.ok(["collections", "list"])
      expect(sent(t)).toEqual([
        "http://ci.test/v1/projects/prj_ci/collections Bearer nohead_sk_ci",
      ])
    })

    it("asks which project with several saved keys and none chosen", async () => {
      const t = setup({})
      expect(await run(["collections", "list"], t.runtime)).toBe(ExitCode.Usage)
      expect(t.err()).toContain(
        `API keys are saved for several projects: ${PROJECT_ID} (laptop), prj_ci. Choose one: pass --project, set NOHEAD_PROJECT, or run \`nohead link <project>\` in this folder.`
      )
      expect(t.requests).toHaveLength(0)

      // A command that needs no key still runs.
      t.runtime.fetch = async () =>
        contractResponse("health_check", {
          status: "ok",
          version: "v1",
          time: NOW,
        })
      await t.ok(["health"])
    })

    it("says to log in when the chosen project has no saved key", async () => {
      const flag = setup({})
      expect(
        await run(["--project", "prj_new", "collections", "list"], flag.runtime)
      ).toBe(ExitCode.Usage)
      expect(flag.err()).toContain(
        "No API key saved for project prj_new. Run `nohead login` with one of that project's API keys"
      )

      const link = setup(
        {},
        { cwd: "/work/app", files: { "/work/nohead.json": linked("prj_new") } }
      )
      expect(await run(["collections", "list"], link.runtime)).toBe(
        ExitCode.Usage
      )
      expect(link.err()).toContain(
        "No API key saved for project prj_new, which /work/nohead.json links to. Run `nohead login`"
      )
      expect([...flag.requests, ...link.requests]).toHaveLength(0)
    })

    it("refuses a nohead.json that is not JSON or names no project", async () => {
      const broken = setup({}, { files: { "/work/nohead.json": "{" } })
      expect(await run(["collections", "list"], broken.runtime)).toBe(
        ExitCode.Usage
      )
      expect(broken.err()).toContain(
        "/work/nohead.json is not valid JSON; fix or delete it"
      )
      // Given a project, the CLI never reads it.
      await broken.ok(["--project", "prj_ci", "collections", "list"])

      const empty = setup(
        {},
        { files: { "/work/nohead.json": '{ "project": 42 }' } }
      )
      expect(await run(["collections", "list"], empty.runtime)).toBe(
        ExitCode.Usage
      )
      expect(empty.err()).toContain(
        "/work/nohead.json names no project; run `nohead link <project>` or delete it"
      )
    })

    // A key from the environment brings its own project; a folder's
    // nohead.json is for saved keys.
    it("ignores nohead.json for NOHEAD_API_KEY, asking the API for its project", async () => {
      const t = setup(
        { NOHEAD_API_KEY: "nohead_sk_env" },
        { files: { "/work/nohead.json": linked("prj_ci") } }
      )
      await t.ok(["collections", "list"])
      t.runtime.env = { ...t.runtime.env, NOHEAD_PROJECT: "prj_env" }
      await t.ok(["collections", "list"])
      expect(sent(t)).toEqual([
        "https://api.nohead.io/v1/me Bearer nohead_sk_env",
        `https://api.nohead.io/v1/projects/${PROJECT_ID}/collections Bearer nohead_sk_env`,
        "https://api.nohead.io/v1/projects/prj_env/collections Bearer nohead_sk_env",
      ])
    })

    it("takes the API URL and key from flags, then the environment", async () => {
      const t = setup({
        NOHEAD_API_URL: "http://env.test",
        NOHEAD_API_KEY: "nohead_sk_env",
      })
      await t.ok(["whoami"])
      await t.ok(["--api-url", "http://flag.test", "whoami"])
      expect(sent(t)).toEqual([
        "http://env.test/v1/me Bearer nohead_sk_env",
        "http://flag.test/v1/me Bearer nohead_sk_env",
      ])
      expect(t.out()).toContain("from:    NOHEAD_API_KEY")
    })

    // As in the SDKs: an .envrc's `NOHEAD_API_KEY=` must not hide the key.
    it("treats empty environment variables as unset", async () => {
      const t = setup(
        { NOHEAD_API_URL: "", NOHEAD_API_KEY: "", NOHEAD_PROJECT: "" },
        { files: { "/work/nohead.json": linked(PROJECT_ID) } }
      )
      await t.ok(["whoami"])
      expect(t.out()).toContain("from:    saved key")
      await t.ok(["collections", "list"])
      expect(sent(t)).toEqual([
        "http://saved.test/v1/me Bearer nohead_sk_saved",
        `http://saved.test/v1/projects/${PROJECT_ID}/collections Bearer nohead_sk_saved`,
      ])
    })

    it("says where the project came from in whoami", async () => {
      const t = setup(
        {},
        {
          cwd: "/work/app",
          files: { "/work/nohead.json": linked(PROJECT_ID) },
        }
      )
      await t.ok(["whoami"])
      expect(t.out()).toContain(
        `project: ${PROJECT_ID} (from /work/nohead.json)`
      )

      const json = setup(
        {},
        { cwd: "/work/app", files: { "/work/nohead.json": linked(PROJECT_ID) } }
      )
      await json.ok(["--json", "whoami"])
      expect(json.json()).toEqual({
        ...ME,
        project_source: "nohead.json",
        link_file: "/work/nohead.json",
      })

      const sources = async (argv: string[], vars: Record<string, string>) => {
        const s = setup(vars, {
          files: saved({ [PROJECT_ID]: keys[PROJECT_ID] }),
        })
        await s.ok(["--json", ...argv, "whoami"])
        return s.json().project_source
      }
      expect(await sources(["--project", PROJECT_ID], {})).toBe("--project")
      expect(await sources([], { NOHEAD_PROJECT: PROJECT_ID })).toBe(
        "NOHEAD_PROJECT"
      )
      expect(await sources([], {})).toBe("only_saved_key")
      expect(await sources([], { NOHEAD_API_KEY: "nohead_sk_env" })).toBe(
        "NOHEAD_API_KEY"
      )
    })
  })

  describe("logout", () => {
    const keys = {
      [PROJECT_ID]: {
        api_url: "http://saved.test",
        api_key: "nohead_sk_saved",
        name: "laptop",
      },
      prj_ci: { api_url: "http://ci.test", api_key: "nohead_sk_ci" },
    }

    it("forgets the key of the chosen project only", async () => {
      const t = testRuntime({ env, files: saved(keys) })

      await t.ok(["--project", PROJECT_ID, "logout"])
      expect(config(t)).toEqual({ keys: { prj_ci: keys.prj_ci } })
      expect(t.out()).toContain(
        `Forgot the API key laptop saved for project ${PROJECT_ID}`
      )
      expect(t.out()).toContain("stays valid until you revoke it")
    })

    it("forgets the linked project's key, or the only one", async () => {
      const t = testRuntime({
        env,
        files: { ...saved(keys), "/work/nohead.json": '{"project":"prj_ci"}' },
      })
      await t.ok(["--json", "logout"])
      expect(t.json()).toEqual({ project_id: "prj_ci", removed: true })
      expect(Object.keys(config(t).keys)).toEqual([PROJECT_ID])

      const only = testRuntime({
        env,
        files: saved({ prj_ci: keys.prj_ci }),
      })
      await only.ok(["logout"])
      expect(config(only)).toEqual({ keys: {} })
    })

    it("asks which project with several keys and none chosen", async () => {
      const t = testRuntime({ env, files: saved(keys) })
      expect(await run(["logout"], t.runtime)).toBe(ExitCode.Usage)
      expect(t.err()).toContain("API keys are saved for several projects")
      expect(t.written).toEqual({})
    })

    it("says when there is nothing to forget", async () => {
      const t = testRuntime({ env, files: saved(keys) })
      await t.ok(["--project", "prj_new", "logout"])
      expect(t.out()).toContain("No API key saved for project prj_new.")

      const none = testRuntime({ env })
      await none.ok(["logout"])
      expect(none.out()).toContain("No API keys are saved.")
      expect({ ...t.written, ...none.written }).toEqual({})
    })
  })
})

describe("link", () => {
  const env = { HOME: "/home/ada" }
  const configFile = "/home/ada/.config/nohead/config.json"

  it("writes nohead.json in the current folder", async () => {
    const t = testRuntime({ env, cwd: "/work/site" })

    await t.ok(["link", PROJECT_ID])
    expect(t.text("/work/site/nohead.json")).toBe(
      `{\n  "project": "${PROJECT_ID}"\n}\n`
    )
    expect(t.out()).toContain(
      `Linked /work/site/nohead.json to project ${PROJECT_ID}.`
    )
    // No key is saved for it yet.
    expect(t.err()).toContain(
      `No API key is saved for project ${PROJECT_ID}: run \`nohead login\``
    )
  })

  it("says nothing more when the project's key is saved", async () => {
    const t = testRuntime({
      env,
      files: {
        [configFile]: JSON.stringify({
          keys: {
            [PROJECT_ID]: { api_url: "http://api.test", api_key: "k" },
          },
        }),
      },
    })

    await t.ok(["--json", "link", PROJECT_ID])
    expect(t.json()).toEqual({
      project: PROJECT_ID,
      link_file: "/work/nohead.json",
      saved_key: true,
    })
    expect(t.err()).toBe("")
  })

  it("replaces the project in an existing nohead.json, keeping the rest", async () => {
    const t = testRuntime({
      env,
      files: {
        "/work/nohead.json": JSON.stringify({
          project: "prj_old",
          schema: "x.yaml",
        }),
      },
    })

    await t.ok(["link", "prj_new"])
    expect(JSON.parse(t.text("/work/nohead.json"))).toEqual({
      project: "prj_new",
      schema: "x.yaml",
    })
  })

  it("refuses what is not a project ID, or a nohead.json it cannot merge into", async () => {
    const t = testRuntime({
      env,
      files: { "/work/nohead.json": "[1, 2" },
    })

    expect(await run(["link", "key_123"], t.runtime)).toBe(ExitCode.Usage)
    expect(t.err()).toContain("key_123 is not a project ID (prj_...)")

    expect(await run(["link", PROJECT_ID], t.runtime)).toBe(ExitCode.Usage)
    expect(t.err()).toContain(
      "/work/nohead.json is not valid JSON; fix or delete it"
    )
    expect(t.written).toEqual({})
  })
})

describe("assets", () => {
  // The SDK reads the upload URL's expiry against the real clock.
  const pendingUpload = {
    ...asset("pending"),
    upload: {
      method: "PUT",
      url: "https://storage.test/bucket/key?X-Amz-Signature=x",
      headers: { "Content-Type": "image/png" },
      expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
    },
  }
  it("asks for something to update before calling the API", async () => {
    const t = testRuntime({ routes: {} })
    expect(await run(["assets", "update", asset().id], t.runtime)).toBe(
      ExitCode.Usage
    )
    expect(t.requests).toHaveLength(0)
  })

  it("searches assets and lists them by kind", async () => {
    let query: URLSearchParams | undefined
    const t = testRuntime({
      routes: {
        "GET /v1/me": me,
        [`GET /v1/projects/${PROJECT_ID}/assets`]: (request) => {
          query = new URL(request.url).searchParams
          return contractResponse("assets_list", page([asset("ready")]))
        },
      },
    })

    await t.ok([
      "assets",
      "list",
      "--search",
      "hero jpg",
      "--kind",
      "image,video",
    ])
    expect(query?.get("q")).toBe("hero jpg")
    expect(query?.get("filter[kind][in]")).toBe("image,video")
    expect(t.out()).toContain(asset().id)
  })

  it("ends at a page with the next cursor, or follows every page with --all", async () => {
    const api = () =>
      testRuntime({
        routes: {
          "GET /v1/me": me,
          [`GET /v1/projects/${PROJECT_ID}/assets`]: (request) =>
            new URL(request.url).searchParams.get("cursor")
              ? contractResponse("assets_list", page([asset()]))
              : contractResponse("assets_list", page([asset()], "next-page")),
        },
      })
    const assetQueries = (t: ReturnType<typeof api>) =>
      t.requests
        .filter((r) => r.url.includes("/assets"))
        .map((r) => new URL(r.url).searchParams)

    const one = api()
    await one.ok(["assets", "list", "--kind", "image,"])
    expect(one.out()).toContain("More: --cursor next-page")
    expect(assetQueries(one)[0].get("filter[kind][in]")).toBe("image")

    const all = api()
    await all.ok(["--json", "assets", "list", "--all", "--search", ""])
    expect(all.json().data).toHaveLength(2)
    const [first, second] = assetQueries(all)
    expect(first.has("q")).toBe(false)
    expect(second.get("cursor")).toBe("next-page")
  })

  it("refuses an unknown kind before calling the API", async () => {
    const t = testRuntime({ routes: {} })
    expect(await run(["assets", "list", "--kind", "photo"], t.runtime)).toBe(
      ExitCode.Usage
    )
    expect(t.err()).toContain(
      '--kind takes image, video, audio, document, other, not "photo"'
    )
    expect(t.requests).toHaveLength(0)
  })

  it("uploads a file straight to storage, then completes it", async () => {
    let stored: Uint8Array | undefined
    const t = testRuntime({
      files: { "cover.png": new Uint8Array([1, 2, 3]) },
      routes: {
        "GET /v1/me": me,
        [`POST /v1/projects/${PROJECT_ID}/assets`]: () =>
          contractResponse("assets_upload", pendingUpload, { status: 201 }),
        "GET /v1/assets/ast_01J9ZQ3F8X5W2K7M4N6P0R1S2T": () =>
          contractResponse("assets_get", asset("pending")),
        "PUT /bucket/key": async (request) => {
          stored = new Uint8Array(await request.arrayBuffer())
          return new Response(null, { status: 200 })
        },
        "POST /v1/assets/ast_01J9ZQ3F8X5W2K7M4N6P0R1S2T/complete": () =>
          contractResponse("assets_complete", asset("ready")),
      },
    })

    await t.ok(["assets", "upload", "cover.png"])

    expect(await body(t.requests[1])).toEqual({
      filename: "cover.png",
      content_type: "image/png",
      byte_size: 3,
    })
    const put = t.requests.find((r) => r.method === "PUT")!
    expect(put.headers.get("Content-Type")).toBe("image/png")
    expect(put.headers.get("Authorization")).toBeNull()
    expect(Array.from(stored!)).toEqual([1, 2, 3])
    expect(t.out().trim()).toBe("ast_01J9ZQ3F8X5W2K7M4N6P0R1S2T")
  })

  it("reports storage that is down or refuses the bytes", async () => {
    const storage = (put: Handler) =>
      testRuntime({
        files: { "cover.png": new Uint8Array([1, 2, 3]) },
        routes: {
          "GET /v1/me": me,
          [`POST /v1/projects/${PROJECT_ID}/assets`]: () =>
            contractResponse("assets_upload", pendingUpload, { status: 201 }),
          "PUT /bucket/key": put,
        },
      })

    const down = storage(() => {
      throw new TypeError("fetch failed")
    })
    expect(
      await withoutWaiting(() =>
        run(["assets", "upload", "cover.png"], down.runtime)
      )
    ).toBe(ExitCode.Network)
    expect(down.err()).toContain("Could not reach storage; retrying")
    expect(down.err()).toContain("Could not reach storage: fetch failed")

    const refused = storage(() => new Response("denied", { status: 403 }))
    expect(
      await run(["--json", "assets", "upload", "cover.png"], refused.runtime)
    ).toBe(ExitCode.ApiError)
    expect(JSON.parse(refused.err()).error.type).toBe("upload_failed")
  })

  // Tools run some dotfiles from the current directory (.pnpmfile.cjs).
  it("saves a dotfile under the asset's ID", async () => {
    const dotfile = { ...asset("ready"), filename: ".pnpmfile.cjs" }
    const t = testRuntime({
      routes: {
        "GET /v1/assets/ast_01J9ZQ3F8X5W2K7M4N6P0R1S2T": () =>
          contractResponse("assets_get", dotfile),
        "GET /original": () => new Response(new Uint8Array([1])),
      },
    })

    await t.ok(["assets", "download", dotfile.id])
    expect(Object.keys(t.written)).toEqual([`${dotfile.id}.pnpmfile.cjs`])
  })

  it("reports storage that is down or stalls as a network error", async () => {
    const download = (file: Handler) =>
      testRuntime({
        routes: {
          "GET /v1/assets/ast_01J9ZQ3F8X5W2K7M4N6P0R1S2T": () =>
            contractResponse("assets_get", asset("ready")),
          "GET /original": file,
        },
      })
    const argv = ["--json", "assets", "download", asset().id]

    const down = download(() => {
      throw new TypeError("fetch failed")
    })
    expect(await run(argv, down.runtime)).toBe(ExitCode.Network)
    expect(JSON.parse(down.err()).error).toEqual({
      type: "network_error",
      message: "Could not reach storage: fetch failed",
    })

    fakeTimeouts()
    // Headers, then a body that never ends: as fetch does, reading it
    // fails with the reason once the signal aborts.
    const stalled = download(
      (request) =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([1]))
              request.signal.addEventListener("abort", () =>
                controller.error(request.signal.reason)
              )
            },
          })
        )
    )
    expect(await withoutWaiting(() => run(argv, stalled.runtime))).toBe(
      ExitCode.Network
    )
    expect(JSON.parse(stalled.err()).error).toEqual({
      type: "network_error",
      message: "Could not reach storage: The download timed out after 60000 ms",
    })
    expect(stalled.written).toEqual({})
  })

  it("has nothing to download for an upload never completed", async () => {
    const pending = asset("pending")
    const t = testRuntime({
      routes: {
        "GET /v1/assets/ast_01J9ZQ3F8X5W2K7M4N6P0R1S2T": () =>
          contractResponse("assets_get", pending),
      },
    })

    expect(
      await run(["--json", "assets", "download", pending.id], t.runtime)
    ).toBe(ExitCode.ApiError)
    expect(JSON.parse(t.err()).error.type).toBe("not_uploaded")
    expect(t.written).toEqual({})
  })

  it("never replaces an existing file without --force, and prints names without escape codes", async () => {
    const named = {
      ...asset("ready"),
      filename: "cover\u001b]0;pwned\u0007.png",
    }
    const download = () =>
      testRuntime({
        files: { "cover]0;pwned.png": "mine" },
        routes: {
          "GET /v1/assets/ast_01J9ZQ3F8X5W2K7M4N6P0R1S2T": () =>
            contractResponse("assets_get", {
              ...named,
              filename: "cover]0;pwned.png",
            }),
          "GET /original": () => new Response(new Uint8Array([1, 2, 3])),
        },
      })

    const refused = download()
    expect(await run(["assets", "download", named.id], refused.runtime)).toBe(
      ExitCode.Usage
    )
    expect(refused.err()).toContain("already exists; pass --force")
    expect(refused.written).toEqual({})

    const forced = download()
    await forced.ok(["assets", "download", named.id, "--force"])
    expect(
      Array.from(forced.written["cover]0;pwned.png"] as Uint8Array)
    ).toEqual([1, 2, 3])

    const shown = testRuntime({
      routes: {
        "GET /v1/assets/ast_01J9ZQ3F8X5W2K7M4N6P0R1S2T": () =>
          contractResponse("assets_get", named),
      },
    })
    await shown.ok(["assets", "get", named.id])
    expect(shown.out()).toContain("cover]0;pwned.png")
    expect(shown.out()).not.toContain("\u001b")
    expect(shown.out()).not.toContain("\u0007")
  })

  it("prints image URLs for the requested options, with no request for them", async () => {
    const image = "https://images.test/plain/p1/a1"
    const t = testRuntime({
      routes: {
        "GET /v1/assets/ast_01J9ZQ3F8X5W2K7M4N6P0R1S2T": () =>
          contractResponse("assets_get", { ...asset(), image_url: image }),
      },
    })

    await t.ok([
      "assets",
      "url",
      "ast_01J9ZQ3F8X5W2K7M4N6P0R1S2T",
      "--width",
      "800",
      "--height",
      "600",
      "--fit",
      "cover",
      "--format",
      "webp",
    ])
    expect(t.out().trim()).toBe(
      "https://images.test/rs:fill:800:600/plain/p1/a1@webp"
    )
    expect(t.requests).toHaveLength(1)

    const other = testRuntime()
    expect(
      await run(
        ["assets", "url", "ast_01J9ZQ3F8X5W2K7M4N6P0R1S2T", "--fit", "crop"],
        other.runtime
      )
    ).toBe(ExitCode.Usage)
    expect(other.err()).toContain(
      "option '--fit <fit>' argument 'crop' is invalid. Allowed choices are contain, cover, fill."
    )
    expect(other.requests).toHaveLength(0)
  })

  it("narrows a project-wide search by published_at only", async () => {
    const t = testRuntime({ routes: {} })

    expect(
      await run(["search", "hello", "--filter", "price<5"], t.runtime)
    ).toBe(ExitCode.Usage)
    expect(t.err()).toContain('only --filter "published_at exists"')
  })
})

describe("webhooks", () => {
  it("creates a webhook for chosen events and prints its secret", async () => {
    const t = testRuntime({
      routes: {
        "GET /v1/me": me,
        [`POST /v1/projects/${PROJECT_ID}/webhooks`]: async (request) =>
          contractResponse(
            "webhooks_create",
            {
              id: "wh_01J9ZQ3F8X5W2K7M4N6P0R1S2T",
              object: "webhook",
              project_id: PROJECT_ID,
              ...(await body(request)),
              enabled: true,
              deleted_at: null,
              purge_after: null,
              secret: "whsec_c2VjcmV0",
              created_at: NOW,
              updated_at: NOW,
            },
            { status: 201 }
          ),
      },
    })

    await t.ok([
      "webhooks",
      "create",
      "--url",
      "https://example.com/hook",
      "--events",
      "record.created, record.published",
    ])

    expect(await body(t.requests[1])).toEqual({
      url: "https://example.com/hook",
      description: null,
      event_types: ["record.created", "record.published"],
    })
    expect(t.out()).toContain("Signing secret: whsec_c2VjcmV0")
  })
})

const auditEvent = {
  id: "evt_01J9ZQ3F8X5W2K7M4N6P0R1S2T",
  object: "event",
  organization_id: "org_01J9ZQ3F8X5W2K7M4N6P0R1S2T",
  project: { id: PROJECT_ID, name: "Website" },
  type: "record.published",
  resource: {
    type: "record",
    id: "rec_01J9ZQ3F8X5W2K7M4N6P0R1S2T",
  },
  actor: {
    type: "user",
    id: "usr_01J9ZQ3F8X5W2K7M4N6P0R1S2T",
    name: "Ada",
  },
  via: "ui",
  metadata: { revision: 2 },
  request_id: null,
  created_at: NOW,
}

describe("audit", () => {
  it("lists the project's audit events with filters", async () => {
    const t = testRuntime({
      routes: {
        "GET /v1/me": me,
        [`GET /v1/projects/${PROJECT_ID}/audit-events`]: () =>
          contractResponse("audit_events_list", {
            data: [auditEvent],
            meta: { next_cursor: null, has_more: false },
          }),
      },
    })

    await t.ok([
      "audit",
      "--type",
      "record.*",
      "--since",
      "2026-09-01T00:00:00Z",
      "--limit",
      "5",
    ])

    const url = new URL(t.requests[1].url)
    expect(url.searchParams.get("filter[type]")).toBe("record.*")
    expect(url.searchParams.get("filter[created_at][gte]")).toBe(
      "2026-09-01T00:00:00Z"
    )
    expect(url.searchParams.has("filter[created_at][lt]")).toBe(false)
    expect(url.searchParams.get("limit")).toBe("5")
    expect(t.out()).toMatch(/Ada\s+ui\s+record\.published/)
  })
})

describe("drafts", () => {
  it("starts a record's draft, lists it and merges it", async () => {
    const started = draft({ title: "Hello again" })
    const t = testRuntime({
      routes: {
        [`POST /v1/records/${REC_A}/drafts`]: () =>
          contractResponse("drafts_create", started, { status: 201 }),
        [`GET /v1/records/${REC_A}/drafts`]: () =>
          contractResponse("record_drafts_list", {
            data: [started],
            meta: { next_cursor: null, has_more: false },
          }),
        [`POST /v1/drafts/${DRF_A}/merge`]: () =>
          contractResponse(
            "drafts_merge",
            record(REC_A, { title: "Hello again" }, { revision: 3 })
          ),
      },
    })

    await t.ok([
      "--note",
      "Typo",
      "drafts",
      "create",
      REC_A,
      "--set",
      "title=Hello again",
    ])
    expect(await body(t.requests[0])).toEqual({
      data: { title: "Hello again" },
    })
    expect(t.out()).toContain(
      `Started ${DRF_A} for ${REC_A} (changes title). Merge it with: nohead drafts merge ${DRF_A}`
    )

    await t.ok(["drafts", "list", "posts", "--record", REC_A])
    expect(t.out()).toMatch(new RegExp(`${DRF_A}\\s+${REC_A}\\s+1\\s+title`))

    await t.ok(["--note", "Typo", "drafts", "merge", DRF_A])
    // A merge makes the record's revision, so it carries the note.
    expect(t.requests[2].headers.get("Nohead-Change-Note")).toBe("Typo")
    expect(t.out()).toContain(`Merged ${DRF_A} into ${REC_A} (revision 3)`)
  })

  it("starts a draft from an earlier revision without data", async () => {
    const t = testRuntime({
      routes: {
        [`POST /v1/records/${REC_A}/drafts`]: () =>
          contractResponse("drafts_create", draft({ title: "Old" }), {
            status: 201,
          }),
      },
    })

    await t.ok(["drafts", "create", REC_A, "--from-revision", "1"])
    expect(await body(t.requests[0])).toEqual({ from_revision: 1 })
  })

  it("updates a draft at a revision, and schedules its merge", async () => {
    const t = testRuntime({
      routes: {
        [`PATCH /v1/drafts/${DRF_A}`]: () =>
          contractResponse(
            "drafts_update",
            draft({ title: "Hello" }, { revision: 2 })
          ),
        [`PUT /v1/drafts/${DRF_A}/schedule`]: async (request) =>
          contractResponse(
            "drafts_schedule",
            draft(
              { title: "Hello" },
              {
                schedule: {
                  merge_at: (await body(request)).merge_at,
                  last_error: null,
                },
              }
            )
          ),
        [`DELETE /v1/drafts/${DRF_A}/schedule`]: () =>
          contractResponse("drafts_unschedule", draft({ title: "Hello" })),
      },
    })

    await t.ok([
      "drafts",
      "update",
      DRF_A,
      "--set",
      "title=Hello",
      "--if-revision",
      "1",
    ])
    expect(t.requests[0].headers.get("If-Match")).toBe('"1"')
    expect(t.out()).toContain(`Updated ${DRF_A} (revision 2)`)

    await t.ok(["drafts", "schedule", DRF_A, "--merge-at", "+2h"])
    expect(await body(t.requests[1])).toEqual({
      merge_at: "2026-09-27T14:00:00.000Z",
    })
    expect(t.out()).toContain(`${DRF_A} merges at 2026-09-27T14:00:00.000Z`)

    await t.ok(["drafts", "unschedule", DRF_A])
    expect(t.requests[2].method).toBe("DELETE")
  })

  it("discards a draft only with --yes, and never schedules no time", async () => {
    const t = testRuntime({
      routes: {
        [`DELETE /v1/drafts/${DRF_A}`]: () =>
          contractResponse("drafts_discard", draft({ title: "Hello" })),
      },
    })

    expect(await run(["drafts", "discard", DRF_A], t.runtime)).toBe(
      ExitCode.Usage
    )
    expect(
      await run(["drafts", "schedule", DRF_A, "--merge-at", "none"], t.runtime)
    ).toBe(ExitCode.Usage)
    expect(t.requests).toHaveLength(0)

    await t.ok(["drafts", "discard", DRF_A, "--yes"])
    expect(t.out()).toContain(`Discarded ${DRF_A}`)
  })
})

describe("records bulk", () => {
  const bulkResult = (
    action: string,
    results: { id: string; ok: boolean; changed?: boolean }[]
  ) =>
    contractResponse("records_bulk", {
      object: "record_batch",
      action,
      succeeded: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results: results.map((r) =>
        r.ok
          ? {
              id: r.id,
              status: "succeeded",
              changed: r.changed ?? true,
              record: record(r.id, { title: "T" }),
            }
          : {
              id: r.id,
              status: "failed",
              error: { type: "not_found", message: "Record not found" },
            }
      ),
    })

  it("selects records with filters and applies the action", async () => {
    const t = testRuntime({
      routes: {
        "GET /v1/collections/posts/records": () =>
          contractResponse(
            "records_list",
            page([
              record(REC_A, { title: "One" }),
              record(REC_B, { title: "Two" }),
            ])
          ),
        "POST /v1/collections/posts/record-batches": () =>
          bulkResult("publish", [
            { id: REC_A, ok: true },
            { id: REC_B, ok: true, changed: false },
          ]),
      },
    })

    await t.ok([
      "records",
      "bulk",
      "publish",
      "posts",
      "--status",
      "unpublished",
    ])
    expect(
      new URL(t.requests[0].url).searchParams.get(
        "filter[published_at][exists]"
      )
    ).toBe("false")
    expect(await body(t.requests[1])).toEqual({
      action: "publish",
      record_ids: [REC_A, REC_B],
    })
    expect(t.out()).toContain("publish: 1 changed, 1 unchanged, 0 failed")
  })

  it("sends update data and fails when any record fails", async () => {
    const t = testRuntime({
      routes: {
        "POST /v1/collections/posts/record-batches": () =>
          bulkResult("update", [
            { id: REC_A, ok: true },
            { id: "rec_missing", ok: false },
          ]),
      },
    })

    expect(
      await run(
        [
          "records",
          "bulk",
          "update",
          "posts",
          REC_A,
          "rec_missing",
          "--set",
          "category=news",
        ],
        t.runtime
      )
    ).toBe(ExitCode.ApiError)
    expect(await body(t.requests[0])).toEqual({
      action: "update",
      record_ids: [REC_A, "rec_missing"],
      data: { category: "news" },
    })
    expect(t.out()).toContain("rec_missing: Record not found")
  })

  it("refuses to run without a selection", async () => {
    for (const args of [
      ["records", "bulk", "publish", "posts"],
      ["records", "bulk", "archive", "posts", REC_A],
      ["records", "bulk", "publish", "posts", REC_A, "--status", "unpublished"],
    ]) {
      const t = testRuntime()
      expect(await run(args, t.runtime), args.join(" ")).toBe(ExitCode.Usage)
      expect(t.requests).toHaveLength(0)
    }
  })
})

describe("rate limits", () => {
  const limited = (retryAfter: number) =>
    contractResponse(
      "me_get",
      {
        error: {
          type: "rate_limited",
          message: `Too many requests; retry in ${retryAfter} seconds`,
          request_id: "req_01J9ZQ3F8X5W2K7M4N6P0R1S2T",
        },
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(retryAfter),
          "RateLimit-Limit": "600",
          "RateLimit-Remaining": "0",
          "RateLimit-Reset": String(retryAfter),
        },
      }
    )

  it("waits out 429s and retries", async () => {
    let calls = 0
    const t = testRuntime({
      routes: { "GET /v1/me": () => (++calls < 3 ? limited(2) : me()) },
    })

    await withoutWaiting(() => t.ok(["whoami"]))
    expect(t.requests).toHaveLength(3)
    expect(t.err()).toContain("Rate limited; retrying in 2s")
  })

  // How many attempts, and which waits are too long, is the SDK's (its
  // retries tests); the CLI reports what it gave up on.
  it("reports the 429 it gave up on", async () => {
    const t = testRuntime({ routes: { "GET /v1/me": () => limited(1) } })
    expect(await withoutWaiting(() => run(["whoami"], t.runtime))).toBe(
      ExitCode.ApiError
    )
    expect(t.err()).toContain("Too many requests")
  })
})

describe("transient failures", () => {
  it("retries after network errors and 5xx, and says so", async () => {
    let calls = 0
    const t = testRuntime({
      routes: {
        "GET /v1/me": () => {
          calls++
          if (calls === 1) throw new TypeError("fetch failed")
          if (calls === 2) return raw(new Response("", { status: 503 }))
          return me()
        },
      },
    })

    await withoutWaiting(() => t.ok(["whoami"]))
    expect(calls).toBe(3)
    expect(t.err()).toContain("Could not reach the API; retrying")
    expect(t.err()).toContain("API unavailable (HTTP 503); retrying")
  })

  // Repeated writes keep their Idempotency-Key: the SDK's retries tests.
  it("gives up with exit code 3, and says nothing else with --json", async () => {
    const down = testRuntime({
      routes: {
        "GET /v1/me": () => {
          throw new TypeError("fetch failed")
        },
      },
    })
    expect(
      await withoutWaiting(() => run(["--json", "whoami"], down.runtime))
    ).toBe(ExitCode.Network)
    expect(JSON.parse(down.err()).error.type).toBe("network_error")
  })

  it("gives up on an API that never answers with exit code 3", async () => {
    // The SDK's per-attempt timeout; the CLI has no timeout option to
    // shorten it instead.
    fakeTimeouts()
    let calls = 0
    const hanging = testRuntime({
      routes: {
        "GET /v1/me": (request) => {
          calls++
          // As fetch does: rejects with the reason once the signal aborts.
          return new Promise((_, reject) =>
            request.signal.addEventListener("abort", () =>
              reject(request.signal.reason as Error)
            )
          )
        },
      },
    })

    expect(
      await withoutWaiting(() => run(["--json", "whoami"], hanging.runtime))
    ).toBe(ExitCode.Network)
    expect(calls).toBe(4)
    expect(JSON.parse(hanging.err()).error).toEqual({
      type: "network_error",
      message: "Could not reach the API: The request timed out after 60000 ms",
    })
  })
})

describe("unexpected errors", () => {
  it("reports an error body that is not the API's by its status", async () => {
    const t = testRuntime({
      routes: {
        "GET /v1/me": () =>
          raw(
            new Response("<h1>Not Found</h1>", {
              status: 404,
              headers: { "Content-Type": "text/html" },
            })
          ),
      },
    })

    expect(await run(["--json", "whoami"], t.runtime)).toBe(ExitCode.ApiError)
    expect(JSON.parse(t.err()).error).toEqual({
      type: "internal_error",
      message: "Unexpected API response (HTTP 404)",
    })
  })

  // Node's errors name the file (code and path); cli.ts reports them.
  it("reports a file it cannot write as a usage error", async () => {
    const t = testRuntime({
      routes: {
        "GET /v1/collections/posts/records": () =>
          contractResponse("records_list", page([])),
      },
    })
    t.runtime.writeFile = async (path) => {
      throw Object.assign(
        new Error(`EACCES: permission denied, open '${path}'`),
        { code: "EACCES", path }
      )
    }

    expect(
      await run(
        ["records", "export", "posts", "--output", "/backup.jsonl"],
        t.runtime
      )
    ).toBe(ExitCode.Usage)
    expect(t.err()).toContain(
      "/backup.jsonl: EACCES: permission denied, open '/backup.jsonl'"
    )
  })

  it("reports them in the usual shape with exit code 4", async () => {
    const t = testRuntime()
    t.runtime.readStdin = async () => {
      throw new RangeError("stdin exploded")
    }

    expect(await run(["--json", "login"], t.runtime)).toBe(ExitCode.Internal)
    expect(JSON.parse(t.err()).error).toEqual({
      type: "internal_error",
      message: "Unexpected error: stdin exploded",
    })
  })
})

describe("export", () => {
  it("leaves a renamed field's old keys out of the records and drafts", async () => {
    const renamed = collection({
      fields: [
        field({
          key: "headline",
          type: "text",
          aliases: [{ key: "title", expires_at: NOW }],
        }),
      ],
    })
    const t = testRuntime({
      routes: {
        "GET /v1/me": me,
        [`GET /v1/projects/${PROJECT_ID}/collections`]: () =>
          contractResponse("collections_list", page([renamed])),
        [`GET /v1/collections/${COLLECTION_ID}/records`]: () =>
          contractResponse(
            "records_list",
            page([record(REC_A, { headline: "Hi", title: "Hi" })])
          ),
        [`GET /v1/collections/${COLLECTION_ID}/drafts`]: () =>
          contractResponse("drafts_list", {
            data: [
              draft(
                { headline: "Hello", title: "Hello" },
                { changed_fields: ["headline"] }
              ),
            ],
            meta: { next_cursor: null, has_more: false },
          }),
        [`GET /v1/projects/${PROJECT_ID}/assets`]: () =>
          contractResponse("assets_list", page([])),
      },
    })

    await t.ok(["export", "--output", "out"])
    const [exported] = t.text("out/records/posts.jsonl").trim().split("\n")
    expect(JSON.parse(exported).data).toEqual({ headline: "Hi" })
    const [pending] = t.text("out/drafts/posts.jsonl").trim().split("\n")
    expect(JSON.parse(pending).data).toEqual({ headline: "Hello" })
    expect(JSON.parse(t.text("out/manifest.json")).collections).toEqual([
      { slug: "posts", records: 1, drafts: 1 },
    ])
  })

  it("downloads every asset's file with --include-files", async () => {
    const t = testRuntime({
      routes: {
        "GET /v1/me": me,
        [`GET /v1/projects/${PROJECT_ID}/collections`]: () =>
          contractResponse("collections_list", page([])),
        [`GET /v1/projects/${PROJECT_ID}/assets`]: () =>
          contractResponse("assets_list", page([asset("ready")])),
        "GET /original": () => new Response(new Uint8Array([1, 2, 3])),
      },
    })

    await t.ok(["export", "--output", "out", "--include-files"])
    expect(
      Array.from(t.written[`out/assets/${asset().id}`] as Uint8Array)
    ).toEqual([1, 2, 3])
    expect(JSON.parse(t.text("out/manifest.json"))).toMatchObject({
      exported_at: NOW,
      assets: 1,
    })
  })

  it("exports without drafts for a key that can't read them", async () => {
    const t = testRuntime({
      routes: {
        "GET /v1/me": me,
        [`GET /v1/projects/${PROJECT_ID}/collections`]: () =>
          contractResponse("collections_list", page([collection()])),
        [`GET /v1/collections/${COLLECTION_ID}/records`]: () =>
          contractResponse("records_list", page([record(REC_A, {})])),
        [`GET /v1/collections/${COLLECTION_ID}/drafts`]: () =>
          contractResponse(
            "drafts_list",
            {
              error: {
                type: "authorization_error",
                message: "Published-only API keys cannot read drafts",
                request_id: "req_1",
              },
            },
            { status: 403 }
          ),
        [`GET /v1/projects/${PROJECT_ID}/assets`]: () =>
          contractResponse("assets_list", page([])),
      },
    })

    await t.ok(["export", "--output", "out"])
    expect(t.err()).toContain("Skipped drafts: Published-only API keys")
    expect(JSON.parse(t.text("out/manifest.json")).collections).toEqual([
      { slug: "posts", records: 1 },
    ])
    expect(Object.keys(t.written).some((p) => p.includes("drafts/"))).toBe(
      false
    )
  })

  // Paths come from the API's slugs and IDs: a hostile or compromised API
  // must not write outside the export (e.g. over ~/.zshrc).
  it("refuses a slug that is not safe as a file name, before writing it", async () => {
    // Raw: a hostile API is not bound by the contract.
    const hostile = () =>
      raw(Response.json(page([collection({ slug: "../../.zshrc" })])))
    const t = testRuntime({
      routes: {
        "GET /v1/me": me,
        [`GET /v1/projects/${PROJECT_ID}/collections`]: hostile,
        [`GET /v1/collections/${COLLECTION_ID}/records`]: () =>
          contractResponse("records_list", page([])),
      },
    })

    expect(await run(["--json", "export", "--output", "out"], t.runtime)).toBe(
      ExitCode.ApiError
    )
    expect(JSON.parse(t.err()).error.message).toContain(
      "not safe as a file name"
    )
    expect(
      Object.keys(t.written).filter((path) => path.includes(".."))
    ).toEqual([])
  })
})

// A terminal may act on 8-bit CSI or OSC from API content (clear the screen,
// set the title); JSON and YAML escape only C0 on their own.
describe("C1 controls in output", () => {
  const hostile = "a\u009b2Jb\u0085c\u007fd"

  it("escapes them in --json and JSON Lines, keeping the value", async () => {
    const rows = [record(REC_A, { title: hostile })]
    const t = testRuntime({
      routes: {
        "GET /v1/collections/posts/records": () =>
          contractResponse("records_list", page(rows)),
      },
    })

    await t.ok(["records", "export", "posts"])
    await t.ok(["--json", "records", "list", "posts"])

    expect(t.out()).not.toMatch(/[\u007f-\u009f]/)
    expect(t.out()).toContain("\\u009b")
    expect(JSON.parse(t.out().split("\n")[0]).data.title).toBe(hostile)
  })

  it("escapes them in schema YAML, keeping the value", () => {
    const yaml = toYaml([
      { slug: "posts", name: hostile, fields: [] } as unknown as CollectionSpec,
    ])

    expect(yaml).not.toMatch(/[\u007f-\u009f]/)
    expect(fromYaml(yaml, "schema.yaml")[0].name).toBe(hostile)
  })
})

describe("import", () => {
  it("checks the whole export before writing anything", async () => {
    const t = testRuntime({
      files: {
        "out/manifest.json": JSON.stringify({
          format: "nohead-export",
          version: 1,
          exported_at: NOW,
          api_url: "http://api.test",
          project_id: PROJECT_ID,
          include_history: false,
          include_deleted: false,
          collections: [
            { slug: "posts", records: 2, drafts: 2 },
            { slug: "pages", records: 1 },
          ],
        }),
        "out/schema.yaml":
          "collections:\n  posts:\n    fields:\n      title: text\n",
        "out/records/posts.jsonl": `${JSON.stringify(record(REC_A, { title: "Hi" }))}\n{broken\n`,
        "out/drafts/posts.jsonl": `${JSON.stringify({ id: DRF_A, data: {} })}\n${JSON.stringify(draft({ title: "Hey" }, { record_id: REC_B }))}\n`,
      },
    })

    expect(await run(["--json", "import", "out"], t.runtime)).toBe(
      ExitCode.Usage
    )
    const { error } = JSON.parse(t.err())
    expect(error.message).toContain("nothing was imported")
    expect(error.details.map((d: { message: string }) => d.message)).toEqual([
      expect.stringContaining("records/posts.jsonl line 2"),
      "records/posts.jsonl has 1 records; manifest.json says 2",
      "drafts/posts.jsonl line 1 is not a draft (no id, record_id, data or changed_fields)",
      "drafts/posts.jsonl has 1 drafts; manifest.json says 2",
      `drafts/posts.jsonl: ${DRF_A} is for ${REC_B}, which is not in records/posts.jsonl`,
      "pages is in manifest.json but not in schema.yaml",
    ])
    expect(t.requests).toHaveLength(0)
  })

  it("refuses asset IDs that would read files outside the export", async () => {
    const t = testRuntime({
      files: {
        "out/manifest.json": JSON.stringify({
          format: "nohead-export",
          version: 1,
          exported_at: NOW,
          api_url: "http://api.test",
          project_id: PROJECT_ID,
          include_history: false,
          include_deleted: false,
          include_files: true,
          collections: [],
        }),
        "out/schema.yaml": "collections: {}\n",
        "out/assets.jsonl": `${JSON.stringify({ id: "../../.ssh/id_ed25519", filename: "x", content_type: "text/plain" })}\n`,
      },
    })

    expect(await run(["import", "out"], t.runtime)).toBe(ExitCode.Usage)
    expect(t.err()).toContain(
      "assets.jsonl line 1 is not an asset (its id is not an asset ID)"
    )
    expect(t.requests).toHaveLength(0)
  })
})

const WEBHOOK_ID = "wh_01J9ZQ3F8X5W2K7M4N6P0R1S2T"
const DELIVERY_ID = "whd_01J9ZQ3F8X5W2K7M4N6P0R1S2T"
const webhook = {
  id: WEBHOOK_ID,
  object: "webhook",
  project_id: PROJECT_ID,
  url: "https://example.com/hook",
  description: null,
  event_types: ["record.published"],
  enabled: true,
  deleted_at: null,
  purge_after: null,
  created_at: NOW,
  updated_at: NOW,
}
const delivery = {
  id: DELIVERY_ID,
  object: "webhook_delivery",
  webhook_id: WEBHOOK_ID,
  event: {
    id: "evt_01J9ZQ3F8X5W2K7M4N6P0R1S2T",
    type: "record.published",
    created_at: NOW,
  },
  status: "failed",
  attempts_count: 1,
  last_status_code: 500,
  last_error: null,
  last_attempt_at: NOW,
  next_attempt_at: null,
  succeeded_at: null,
  created_at: NOW,
}

const schemaChange = {
  id: "sch_01J9ZQ3F8X5W2K7M4N6P0R1S2T",
  object: "schema_change",
  collection_id: COLLECTION_ID,
  from_version: 1,
  to_version: 2,
  operation: "add_field",
  payload: {},
  actor: {
    type: "api_key",
    id: "key_01J9ZQ3F8X5W2K7M4N6P0R1S2T",
    name: "ci",
  },
  via: "cli",
  note: "Titles",
  request_id: null,
  created_at: NOW,
}

// One request each: what the command sends (checked against the contract by
// the test runtime too), what it prints, and what it prints with --json: the
// response as the API sent it.
describe("commands with a single request", () => {
  const title = field({ key: "title" })

  it.each<{
    argv: string[]
    /** "METHOD /path?query" of the command's last request. */
    request: string
    body?: unknown
    response: Handler
    routes?: Record<string, Handler>
    output: string | RegExp
  }>([
    {
      argv: ["collections", "update", "posts", "--name", "Articles"],
      request: "PATCH /v1/collections/posts",
      body: { name: "Articles" },
      response: () =>
        contractResponse(
          "collections_update",
          collection({ name: "Articles" })
        ),
      output: "Updated collection posts (schema v2)",
    },
    {
      argv: ["collections", "update", "posts", "--no-public-search"],
      request: "PATCH /v1/collections/posts",
      body: { public_search: false },
      response: () => contractResponse("collections_update", collection()),
      output: "Updated collection posts (schema v2)",
    },
    {
      argv: ["collections", "search-index", "posts"],
      request: "GET /v1/collections/posts/search-index",
      response: () =>
        contractResponse("search_index_get", {
          object: "search_index",
          collection_id: COLLECTION_ID,
          index: "01M481FV9XEG39KB7YDGFQ7VPJ_01M5AP23VCFN28W4QZT9NSQBTC",
          status: "ready",
          documents: 3,
          last_built_at: NOW,
          rebuild_requested_at: null,
        }),
      output: /index:\s+01M481FV9XEG39KB7YDGFQ7VPJ_01M5AP23VCFN28W4QZT9NSQBTC/,
    },
    {
      argv: ["collections", "restore", "posts"],
      request: "POST /v1/collections/posts/restore",
      response: () => contractResponse("collections_restore", collection()),
      output: "Restored collection posts",
    },
    {
      argv: ["collections", "history", "posts"],
      request: "GET /v1/collections/posts/schema-changes?limit=100",
      response: () =>
        contractResponse("schema_changes_list", page([schemaChange])),
      output: /v2\s+add_field\s+ci\s+cli\s+\S+\s+Titles/,
    },
    {
      argv: ["fields", "delete", "posts", "title"],
      request: `DELETE /v1/fields/${title.id}`,
      routes: {
        "GET /v1/collections/posts/fields": () =>
          contractResponse("fields_list", page([title])),
      },
      response: () =>
        contractResponse("fields_delete", {
          ...title,
          deleted_at: NOW,
          purge_after: NOW,
        }),
      output: `Deleted field title. Restore it with: nohead fields restore posts ${title.id}`,
    },
    {
      argv: ["records", "unpublish", REC_A],
      request: `DELETE /v1/records/${REC_A}/publication`,
      response: () =>
        contractResponse(
          "records_unpublish",
          record(REC_A, {}, { revision: 3 })
        ),
      output: `Unpublished ${REC_A} (revision 3)`,
    },
    {
      argv: ["records", "delete", REC_A],
      request: `DELETE /v1/records/${REC_A}`,
      response: () =>
        contractResponse(
          "records_delete",
          record(REC_A, {}, { deleted_at: NOW, purge_after: NOW })
        ),
      output: `Deleted ${REC_A}. Undo with: nohead records restore ${REC_A}`,
    },
    {
      argv: ["records", "restore", REC_A],
      request: `POST /v1/records/${REC_A}/restore`,
      response: () =>
        contractResponse("records_restore", record(REC_A, {}, { revision: 4 })),
      output: `Restored ${REC_A} (revision 4)`,
    },
    {
      argv: [
        "assets",
        "update",
        asset().id,
        "--filename",
        "menu.png",
        "--alt",
        "The spring menu",
      ],
      request: `PATCH /v1/assets/${asset().id}`,
      body: { filename: "menu.png", alt: "The spring menu" },
      response: () =>
        contractResponse("assets_update", {
          ...asset(),
          filename: "menu.png",
          alt: "The spring menu",
        }),
      output: "Updated menu.png",
    },
    {
      // An empty --alt clears it.
      argv: ["assets", "update", asset().id, "--alt", ""],
      request: `PATCH /v1/assets/${asset().id}`,
      body: { alt: null },
      response: () => contractResponse("assets_update", asset()),
      output: "Updated cover.png",
    },
    {
      argv: ["assets", "delete", asset().id],
      request: `DELETE /v1/assets/${asset().id}`,
      response: () =>
        contractResponse("assets_delete", {
          ...asset(),
          deleted_at: NOW,
          purge_after: NOW,
        }),
      output: `Deleted cover.png. Restore it with: nohead assets restore ${asset().id}`,
    },
    {
      argv: ["assets", "restore", asset().id],
      request: `POST /v1/assets/${asset().id}/restore`,
      response: () => contractResponse("assets_restore", asset()),
      output: "Restored cover.png",
    },
    {
      argv: ["webhooks", "list"],
      request: `GET /v1/projects/${PROJECT_ID}/webhooks?limit=100`,
      response: () => contractResponse("webhooks_list", page([webhook])),
      output: new RegExp(
        `${WEBHOOK_ID}\\s+https://example.com/hook\\s+record.published\\s+enabled`
      ),
    },
    {
      argv: ["webhooks", "delete", WEBHOOK_ID],
      request: `DELETE /v1/webhooks/${WEBHOOK_ID}`,
      response: () =>
        contractResponse("webhooks_delete", {
          ...webhook,
          deleted_at: NOW,
          purge_after: NOW,
        }),
      output: `Deleted ${WEBHOOK_ID}`,
    },
    {
      argv: ["webhooks", "rotate-secret", WEBHOOK_ID],
      request: `POST /v1/webhooks/${WEBHOOK_ID}/secrets`,
      response: () =>
        contractResponse(
          "webhooks_rotate_secret",
          {
            id: "whs_01J9ZQ3F8X5W2K7M4N6P0R1S2T",
            object: "webhook_secret",
            webhook_id: WEBHOOK_ID,
            expires_at: null,
            secret: "whsec_bmV3",
            created_at: NOW,
          },
          { status: 201 }
        ),
      output: "Signing secret: whsec_bmV3",
    },
    {
      argv: ["webhooks", "test", WEBHOOK_ID],
      request: `POST /v1/webhooks/${WEBHOOK_ID}/test`,
      response: () =>
        contractResponse(
          "webhooks_test",
          { ...delivery, status: "pending", attempts_count: 0 },
          { status: 202 }
        ),
      output: `Queued ${DELIVERY_ID}; follow it with: nohead webhooks delivery ${DELIVERY_ID}`,
    },
    {
      argv: ["webhooks", "deliveries", WEBHOOK_ID, "--status", "failed"],
      request: `GET /v1/webhooks/${WEBHOOK_ID}/deliveries?limit=100&filter%5Bstatus%5D=failed`,
      response: () =>
        contractResponse("webhook_deliveries_list", page([delivery])),
      output: new RegExp(
        `${DELIVERY_ID}\\s+record.published\\s+failed\\s+1\\s+500`
      ),
    },
    {
      argv: ["webhooks", "delivery", DELIVERY_ID],
      request: `GET /v1/webhook-deliveries/${DELIVERY_ID}`,
      response: () =>
        contractResponse("webhook_deliveries_get", {
          ...delivery,
          payload: {
            id: delivery.event.id,
            object: "event",
            type: "record.published",
            created_at: NOW,
            project_id: PROJECT_ID,
            actor: { type: "system", id: null, name: "System" },
            via: "scheduler",
            data: {
              record: record(REC_A, { title: "Hello" }, { published_at: NOW }),
              revision: 2,
              revision_id: "rev_01J9ZQ3F8X5W2K7M4N6P0R1S22",
            },
          },
          attempts: [
            {
              number: 1,
              status_code: 500,
              error: null,
              duration_ms: 120,
              response_body: "oops",
              created_at: NOW,
            },
          ],
        }),
      output: `record.published ${delivery.event.id}: failed\n  #1 500 (120 ms) ${NOW}`,
    },
    {
      argv: ["webhooks", "retry", DELIVERY_ID],
      request: `POST /v1/webhook-deliveries/${DELIVERY_ID}/retry`,
      response: () =>
        contractResponse(
          "webhook_deliveries_retry",
          { ...delivery, status: "pending" },
          { status: 202 }
        ),
      output: `Retrying ${DELIVERY_ID}`,
    },
  ])(
    "$argv.0 $argv.1",
    async ({ argv, request, body: sent, response, routes, output }) => {
      const api = () =>
        testRuntime({
          routes: {
            "GET /v1/me": me,
            ...routes,
            [request.split("?")[0]]: response,
          },
        })
      const lastRequest = async (t: ReturnType<typeof api>) => {
        const last = t.requests.at(-1)!
        const url = new URL(last.url)
        const text = await last.text()
        return {
          request: `${last.method} ${url.pathname}${url.search}`,
          body: text ? JSON.parse(text) : undefined,
        }
      }

      const t = api()
      await t.ok(argv)
      expect(await lastRequest(t)).toEqual({ request, body: sent })
      expect(t.out()).toMatch(output)

      const scripted = api()
      await scripted.ok(["--json", ...argv])
      const last = scripted.requests.at(-1)!
      expect(await lastRequest(scripted)).toEqual({ request, body: sent })
      expect(scripted.json()).toEqual(await (await response(last)).json())
      expect(scripted.err()).toBe("")
    }
  )
})

describe("paged lists", () => {
  it.each<{ argv: string[]; path: string; operation: string; item: unknown }>([
    {
      argv: ["collections", "list"],
      path: `/v1/projects/${PROJECT_ID}/collections`,
      operation: "collections_list",
      item: collection(),
    },
    {
      argv: ["collections", "history", "posts"],
      path: "/v1/collections/posts/schema-changes",
      operation: "schema_changes_list",
      item: schemaChange,
    },
    {
      argv: ["fields", "list", "posts"],
      path: "/v1/collections/posts/fields",
      operation: "fields_list",
      item: field({ key: "title" }),
    },
    {
      argv: ["webhooks", "list"],
      path: `/v1/projects/${PROJECT_ID}/webhooks`,
      operation: "webhooks_list",
      item: webhook,
    },
    {
      argv: ["webhooks", "deliveries", WEBHOOK_ID],
      path: `/v1/webhooks/${WEBHOOK_ID}/deliveries`,
      operation: "webhook_deliveries_list",
      item: delivery,
    },
    {
      argv: ["audit"],
      path: `/v1/projects/${PROJECT_ID}/audit-events`,
      operation: "audit_events_list",
      item: auditEvent,
    },
    {
      argv: ["records", "history", REC_A],
      path: `/v1/records/${REC_A}/revisions`,
      operation: "record_revisions_list",
      item: revision(1),
    },
  ])(
    "$argv.0 $argv.1 ends at a page with the next cursor, or follows every page with --all",
    async ({ argv, path, operation, item }) => {
      const api = () =>
        testRuntime({
          routes: {
            "GET /v1/me": me,
            [`GET ${path}`]: (request) =>
              contractResponse(
                operation,
                new URL(request.url).searchParams.get("cursor")
                  ? page([item])
                  : page([item], "next-page")
              ),
          },
        })
      const lists = (t: ReturnType<typeof api>) =>
        t.requests
          .map((r) => new URL(r.url))
          .filter((url) => url.pathname === path)
          .map((url) => url.searchParams)

      const one = api()
      await one.ok([...argv, "--limit", "1"])
      expect(one.out()).toContain("More: --cursor next-page")
      expect(lists(one).map((q) => q.get("limit"))).toEqual(["1"])

      const json = api()
      await json.ok(["--json", ...argv])
      expect(json.json()).toEqual({
        data: [item],
        meta: { next_cursor: "next-page", has_more: true },
      })

      const next = api()
      await next.ok([...argv, "--cursor", "next-page"])
      expect(next.out()).not.toContain("More:")
      expect(lists(next)[0].get("cursor")).toBe("next-page")

      const all = api()
      await all.ok(["--json", ...argv, "--all"])
      expect(all.json().data).toHaveLength(2)
      expect(lists(all).map((q) => q.get("cursor"))).toEqual([
        null,
        "next-page",
      ])
      // Every page is read anyway, so as few requests as can be.
      expect(lists(all).map((q) => q.get("limit"))).toEqual(["100", "100"])
    }
  )

  // The contract allows it; the SDKs stop there, and so does the hint.
  it("offers no next page when has_more comes without a cursor", async () => {
    const t = testRuntime({
      routes: {
        "GET /v1/me": me,
        [`GET /v1/projects/${PROJECT_ID}/collections`]: () =>
          contractResponse("collections_list", {
            data: [collection()],
            meta: { next_cursor: null, has_more: true },
          }),
      },
    })

    await t.ok(["collections", "list"])
    expect(t.out()).toContain("posts")
    expect(t.out()).not.toContain("More:")
  })

  it.each([["audit"], ["search", "shoes"]])(
    "%s refuses a --limit that is not a positive integer before calling the API",
    async (...argv) => {
      const t = testRuntime({ routes: {} })
      expect(await run([...argv, "--limit", "ten"], t.runtime)).toBe(
        ExitCode.Usage
      )
      expect(t.err()).toContain("--limit must be a positive integer")
      expect(t.requests).toHaveLength(0)
    }
  )
})
