import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { text } from "node:stream/consumers"
import { setTimeout } from "node:timers/promises"

import type { Runtime } from "./context.ts"
import { readSecret } from "./secret.ts"

/** The runtime of the `nohead` process. */
export function nodeRuntime(): Runtime {
  return {
    stdout: (output) => process.stdout.write(output),
    stderr: (output) => process.stderr.write(output),
    env: process.env,
    fetch: globalThis.fetch,
    readFile: (path) => readFile(path, "utf8"),
    readBinaryFile: (path) => readFile(path),
    writeFile: async (path, content, options) => {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, content, { flag: options?.exclusive ? "wx" : "w" })
    },
    readStdin: () => text(process.stdin),
    stdinIsTTY: Boolean(process.stdin.isTTY),
    readSecret: (prompt) =>
      readSecret(process.stdin, (text) => process.stderr.write(text), prompt),
    // Written to a temporary file and renamed, so an interrupted write never
    // leaves a truncated config (the file holds every saved API key).
    writePrivateFile: async (path, content) => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      const temporary = `${path}.${process.pid}.tmp`
      await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 })
      await chmod(temporary, 0o600)
      await rename(temporary, path)
    },
    sleep: (ms) => setTimeout(ms),
    now: () => new Date(),
  }
}
