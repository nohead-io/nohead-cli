import { VERSION as SDK_VERSION } from "@nohead/sdk"
import { describe, expect, it } from "vitest"

import { run, VERSION } from "./cli.ts"
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

  it("exits 0 for --help and prints to stdout", async () => {
    const t = testRuntime()

    await t.ok(["--help"])
    expect(t.out()).toContain("Usage: nohead")
    expect(t.out()).toContain("collections")
  })

  it("prints its version and the SDK's for --version", async () => {
    const t = testRuntime()

    await t.ok(["--version"])
    expect(t.out()).toBe(`${VERSION} (SDK ${SDK_VERSION})\n`)
  })
})
