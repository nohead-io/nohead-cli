import { homedir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { run } from "./cli.ts"
import { configPath } from "./config.ts"
import type { Runtime } from "./context.ts"
import { ExitCode } from "./errors.ts"
import { contractResponse } from "./test/contract.ts"
import { ME, NOW, PROJECT_ID } from "./test/fixtures.ts"
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

describe("a broken config file", () => {
  const CONFIG = "/etc/nohead.json"
  const NOT_JSON = '{"keys": {'
  const key = { NOHEAD_API_KEY: "nohead_sk_test0000000_secret" }
  const { Success, Usage } = ExitCode
  // Only a command that needs a saved key reads it.
  const cases: {
    text: string
    argv: string[]
    env?: Runtime["env"]
    exit: number
    problem?: string
  }[] = [
    { text: NOT_JSON, argv: ["--help"], exit: Success },
    { text: NOT_JSON, argv: ["health"], exit: Success },
    {
      text: NOT_JSON,
      argv: ["--project", PROJECT_ID, "health"],
      exit: Success,
    },
    { text: NOT_JSON, argv: ["whoami"], env: key, exit: Success },
    {
      text: NOT_JSON,
      argv: ["whoami"],
      exit: Usage,
      problem: "is not valid JSON",
    },
    {
      text: NOT_JSON,
      argv: ["--project", PROJECT_ID, "collections", "list"],
      exit: Usage,
      problem: "is not valid JSON",
    },
    // Refused before a key is checked or made, or nohead.json written.
    {
      text: NOT_JSON,
      argv: ["login"],
      exit: Usage,
      problem: "is not valid JSON",
    },
    {
      text: NOT_JSON,
      argv: ["logout"],
      exit: Usage,
      problem: "is not valid JSON",
    },
    {
      text: NOT_JSON,
      argv: ["link", PROJECT_ID],
      exit: Usage,
      problem: "is not valid JSON",
    },
    ...["null", "[]", '"keys"'].map((text) => ({
      text,
      argv: ["whoami"],
      exit: Usage,
      problem: "is not a JSON object",
    })),
  ]
  const named = ({ text, argv, env }: (typeof cases)[number]) =>
    `${text}: nohead ${argv.join(" ")}${env ? " with NOHEAD_API_KEY" : ""}`
  it.each(cases.map((c) => [named(c), c] as const))(
    "%s",
    async (_, { text, argv, env, exit, problem }) => {
      const t = testRuntime({
        env: {
          NOHEAD_CONFIG: CONFIG,
          NOHEAD_API_URL: "http://api.test",
          ...env,
        },
        files: { [CONFIG]: text },
        stdin: "nohead_sk_test0000000_secret\n",
        routes: {
          "GET /v1/health": () =>
            contractResponse("health_check", {
              status: "ok",
              version: "v1",
              time: NOW,
            }),
          "GET /v1/me": () => contractResponse("me_get", ME),
        },
      })

      expect(await run(argv, t.runtime)).toBe(exit)
      if (problem) {
        expect(t.err()).toContain(`${CONFIG} ${problem}; fix or delete it`)
        expect(t.requests).toHaveLength(0)
        expect(t.written).toEqual({})
      }
    }
  )
})
