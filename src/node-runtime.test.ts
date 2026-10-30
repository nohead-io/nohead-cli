import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { nodeRuntime } from "./node-runtime.ts"

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
