import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { browserCommand, nodeRuntime } from "./node-runtime.ts"

let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "nohead-cli-"))
})
afterEach(() => rm(directory, { recursive: true, force: true }))

const mode = async (path: string) => (await stat(path)).mode & 0o777

describe("writePrivateFile", () => {
  it("creates the file and its directory for the current user only", async () => {
    const path = join(directory, "nohead", "config.json")

    await nodeRuntime().writePrivateFile(path, '{"keys":{}}\n')

    expect(await nodeRuntime().readFile(path)).toBe('{"keys":{}}\n')
    expect(await mode(path)).toBe(0o600)
    expect(await mode(join(directory, "nohead"))).toBe(0o700)
  })

  it("replaces a file others could read, leaving no temporary file", async () => {
    const path = join(directory, "config.json")
    await writeFile(path, "old", { mode: 0o644 })

    await nodeRuntime().writePrivateFile(path, "new")

    expect(await nodeRuntime().readFile(path)).toBe("new")
    expect(await mode(path)).toBe(0o600)
    expect(await readdir(directory)).toEqual(["config.json"])
  })
})

describe("writeFile", () => {
  it("creates directories, and refuses to replace a file when exclusive", async () => {
    const path = join(directory, "out", "posts.jsonl")
    const runtime = nodeRuntime()

    await runtime.writeFile(path, "one")
    await expect(
      runtime.writeFile(path, "two", { exclusive: true })
    ).rejects.toMatchObject({ code: "EEXIST", path })
    expect(await runtime.readFile(path)).toBe("one")
  })
})

describe("browserCommand", () => {
  const url = "https://app.nohead.io/cli/login?code=WXYZ-4821&x=(1)"

  it("opens the default browser on each platform", () => {
    expect(browserCommand(url, "darwin", {})).toEqual({
      file: "open",
      args: [url],
      verbatim: false,
    })
    expect(browserCommand(url, "linux", { DISPLAY: ":0" })).toEqual({
      file: "xdg-open",
      args: [url],
      verbatim: false,
    })
    // cmd would run what follows an unescaped &.
    expect(browserCommand(url, "win32", {})).toEqual({
      file: "cmd",
      args: [
        "/c",
        "start",
        '""',
        "https://app.nohead.io/cli/login?code=WXYZ-4821^&x=^(1^)",
      ],
      verbatim: true,
    })
  })

  it("opens none over SSH, or without a display", () => {
    expect(browserCommand(url, "darwin", { SSH_CONNECTION: "1 2 3 4" })).toBe(
      undefined
    )
    expect(browserCommand(url, "linux", { SSH_TTY: "/dev/pts/0" })).toBe(
      undefined
    )
    expect(browserCommand(url, "linux", {})).toBe(undefined)
    expect(
      browserCommand(url, "linux", { WAYLAND_DISPLAY: "wayland-0" })?.file
    ).toBe("xdg-open")
  })
})
