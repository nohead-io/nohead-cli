import { spawn } from "node:child_process"
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { hostname } from "node:os"
import { dirname } from "node:path"
import { text } from "node:stream/consumers"
import { setTimeout } from "node:timers/promises"

import type { Runtime } from "./context.ts"

/** The runtime of the `nohead` process. */
export function nodeRuntime(): Runtime {
  return {
    stdout: (output) => process.stdout.write(output),
    stderr: (output) => process.stderr.write(output),
    env: process.env,
    cwd: () => process.cwd(),
    fetch: globalThis.fetch,
    readFile: (path) => readFile(path, "utf8"),
    readBinaryFile: (path) => readFile(path),
    writeFile: async (path, content, options) => {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, content, { flag: options?.exclusive ? "wx" : "w" })
    },
    readStdin: () => text(process.stdin),
    stdinIsTTY: Boolean(process.stdin.isTTY),
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
    openUrl: (url) => {
      const command = browserCommand(url, process.platform, process.env)
      if (!command) return false
      try {
        // Detached and unwaited: the browser outlives the CLI.
        const child = spawn(command.file, command.args, {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
          windowsVerbatimArguments: command.verbatim,
        })
        child.on("error", () => {})
        child.unref()
      } catch {
        // No opener installed: the URL is printed for the person anyway.
      }
      return true
    },
    hostname: () => hostname(),
  }
}

/**
 * How to open `url` in the default browser on this platform: none in an SSH
 * session, or (Linux and the like) without a display, where xdg-open would
 * fail or start a text browser with no terminal.
 */
export function browserCommand(
  url: string,
  platform: NodeJS.Platform,
  env: Runtime["env"]
): { file: string; args: string[]; verbatim: boolean } | undefined {
  if (env.SSH_CONNECTION || env.SSH_TTY) return undefined
  if (platform === "darwin")
    return { file: "open", args: [url], verbatim: false }
  // start is cmd's own: cmd reads & | < > ^ ( ) as its own, so each is
  // escaped with ^; "" is start's window title, without which a quoted URL
  // would be taken for one.
  if (platform === "win32")
    return {
      file: "cmd",
      args: ["/c", "start", '""', url.replace(/[&|<>^()]/g, "^$&")],
      verbatim: true,
    }
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return undefined
  return { file: "xdg-open", args: [url], verbatim: false }
}
