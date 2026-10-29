import { readFileSync } from "node:fs"

import { VERSION as SDK_VERSION } from "@nohead/sdk"
import { describe, expect, it } from "vitest"

import { describeCommands, run, VERSION } from "./cli.ts"
import { ExitCode } from "./errors.ts"
import { contractResponse } from "./test/contract.ts"
import { testRuntime, withoutWaiting } from "./test/runtime.ts"

const healthy = { status: "ok", version: "v1", time: "2026-09-27T12:00:00Z" }
const health = () => contractResponse("health_check", healthy)

describe("nohead health", () => {
  it("prints a human-readable result", async () => {
    const t = testRuntime({ routes: { "GET /v1/health": health } })

    await t.ok(["health"])
    expect(t.out()).toBe("API v1 is ok\n")
    expect(t.err()).toBe("")
  })

  it("prints exactly one JSON document with --json", async () => {
    const t = testRuntime({ routes: { "GET /v1/health": health } })

    await t.ok(["--json", "health"])
    expect(t.json()).toEqual(healthy)
  })

  it("calls the configured API URL, preferring --api-url over the environment", async () => {
    const env = testRuntime({ routes: { "GET /v1/health": health } })
    const flag = testRuntime({ routes: { "GET /v1/health": health } })

    await env.ok(["health"])
    await flag.ok(["--api-url", "http://flag.test", "health"])

    expect(env.requests[0].url).toBe("http://api.test/v1/health")
    expect(flag.requests[0].url).toBe("http://flag.test/v1/health")
  })

  it("reports API errors on stderr with the request ID and exits 1", async () => {
    const error = {
      type: "service_unavailable",
      message: "Database unavailable",
      request_id: "req_01J9ZQ3F8X5W2K7M4N6P0R1S2T",
    }
    const t = testRuntime({
      routes: {
        "GET /v1/health": () =>
          contractResponse("health_check", { error }, { status: 503 }),
      },
    })

    expect(await withoutWaiting(() => run(["health"], t.runtime))).toBe(
      ExitCode.ApiError
    )
    expect(t.out()).toBe("")
    expect(t.err()).toContain("Error: Database unavailable")
    expect(t.err()).toContain("Request ID: req_01J9ZQ3F8X5W2K7M4N6P0R1S2T")

    const json = testRuntime({
      routes: {
        "GET /v1/health": () =>
          contractResponse("health_check", { error }, { status: 503 }),
      },
    })
    expect(
      await withoutWaiting(() => run(["--json", "health"], json.runtime))
    ).toBe(ExitCode.ApiError)
    expect(JSON.parse(json.err())).toEqual({ error })
  })

  it("lists an API error's details, and --json prints the error as the API sent it", async () => {
    const error = {
      type: "validation_error",
      message: "Record validation failed",
      request_id: "req_01J9ZQ3F8X5W2K7M4N6P0R1S2T",
      details: [
        { field: "title", code: "required", message: "can't be blank" },
        {
          code: "plan_limit",
          message: "Plan limit reached",
          usage: 9,
          limit: 9,
        },
      ],
    }
    const routes = {
      "POST /v1/collections/posts/records": () =>
        contractResponse("records_create", { error }, { status: 422 }),
    }
    const argv = ["records", "create", "posts", "--set", "title="]

    const t = testRuntime({ routes })
    expect(await run(argv, t.runtime)).toBe(ExitCode.ApiError)
    expect(t.err()).toBe(
      [
        "Error: Record validation failed",
        "  - title: can't be blank",
        "  - Plan limit reached",
        "Request ID: req_01J9ZQ3F8X5W2K7M4N6P0R1S2T",
        "",
      ].join("\n")
    )

    const json = testRuntime({ routes })
    expect(await run(["--json", ...argv], json.runtime)).toBe(ExitCode.ApiError)
    expect(json.err()).toBe(`${JSON.stringify({ error }, null, 2)}\n`)
  })
})

describe("usage", () => {
  it("exits 2 for unknown commands and missing arguments", async () => {
    const unknown = testRuntime()
    expect(await run(["nope"], unknown.runtime)).toBe(ExitCode.Usage)
    expect(unknown.out()).toBe("")
    expect(unknown.err()).toContain("unknown command 'nope'")

    const missing = testRuntime()
    expect(await run(["records", "get"], missing.runtime)).toBe(ExitCode.Usage)
    expect(missing.err()).toContain("missing required argument 'id'")

    // Record commands take the ID alone; the old <collection> <id> is refused.
    const excess = testRuntime()
    expect(
      await run(["records", "get", "posts", "rec_1"], excess.runtime)
    ).toBe(ExitCode.Usage)
    expect(excess.err()).toContain("too many arguments")
    expect(excess.requests).toHaveLength(0)
  })

  it("prints usage errors as the error document with --json, help left out", async () => {
    const missing = testRuntime()
    expect(await run(["--json", "records", "get"], missing.runtime)).toBe(
      ExitCode.Usage
    )
    expect(JSON.parse(missing.err())).toEqual({
      error: {
        type: "invalid_request",
        message: "missing required argument 'id'",
      },
    })

    // --json after the command counts too; a command needs a subcommand.
    const bare = testRuntime()
    expect(await run(["records", "--json"], bare.runtime)).toBe(ExitCode.Usage)
    expect(JSON.parse(bare.err()).error.message).toBe(
      "missing command; see --help"
    )
    expect(bare.out()).toBe("")

    const human = testRuntime()
    expect(await run(["records"], human.runtime)).toBe(ExitCode.Usage)
    expect(human.err()).toContain("Usage: nohead records")
  })

  it("exits 0 for --help and prints to stdout", async () => {
    const t = testRuntime()

    await t.ok(["--help"])
    expect(t.out()).toContain("Usage: nohead")
    expect(t.out()).toContain("collections")
    // Only for a local or test API: it works, but isn't offered.
    expect(t.out()).not.toContain("--api-url")
  })

  it("prints its version and the SDK's for --version", async () => {
    const t = testRuntime()

    await t.ok(["--version"])
    expect(t.out()).toBe(`${VERSION} (SDK ${SDK_VERSION})\n`)
  })
})

describe("commands.json", () => {
  // The docs' CLI reference is built from it.
  it("describes the commands as they are: run `npm run commands` if not", () => {
    const written = JSON.parse(
      readFileSync(new URL("../commands.json", import.meta.url), "utf8")
    )
    expect(written).toEqual(JSON.parse(JSON.stringify(describeCommands())))
  })

  it("has a description for every command and argument", () => {
    const missing: string[] = []
    const walk = (
      command: ReturnType<typeof describeCommands>,
      path: string
    ) => {
      if (!command.description) missing.push(path)
      for (const argument of command.arguments)
        if (!argument.description) missing.push(`${path} <${argument.name}>`)
      for (const sub of command.commands) walk(sub, `${path} ${sub.name}`)
    }
    walk(describeCommands(), "nohead")
    expect(missing).toEqual([])
  })
})
