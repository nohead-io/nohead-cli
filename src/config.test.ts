import { homedir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { run } from "./cli.ts"
import { configPath } from "./config.ts"
import { ExitCode } from "./errors.ts"
import { testRuntime } from "./test/runtime.ts"

describe("configPath", () => {
  it("is under ~/.config, or $XDG_CONFIG_HOME, or $NOHEAD_CONFIG", () => {
    expect(configPath({ HOME: "/home/ada" })).toBe(
      "/home/ada/.config/nohead/config.json"
    )
    expect(configPath({ HOME: "/home/ada", XDG_CONFIG_HOME: "/xdg" })).toBe(
      "/xdg/nohead/config.json"
    )
    expect(configPath({ NOHEAD_CONFIG: "/etc/nohead.json" })).toBe(
      "/etc/nohead.json"
    )
  })

  it("treats empty variables as unset", () => {
    expect(
      configPath({ HOME: "/home/ada", XDG_CONFIG_HOME: "", NOHEAD_CONFIG: "" })
    ).toBe("/home/ada/.config/nohead/config.json")
  })

  it("never falls back to the current directory without $HOME", () => {
    expect(configPath({})).toBe(
      join(homedir(), ".config", "nohead", "config.json")
    )
  })
})

describe("readConfig", () => {
  it("refuses a config that is not JSON as a usage error", async () => {
    const t = testRuntime({
      env: { NOHEAD_CONFIG: "/etc/nohead.json" },
      files: { "/etc/nohead.json": '{"profiles": {' },
    })

    expect(await run(["whoami"], t.runtime)).toBe(ExitCode.Usage)
    expect(t.err()).toContain(
      "/etc/nohead.json is not valid JSON; fix or delete it"
    )
    expect(t.requests).toHaveLength(0)
  })
})
