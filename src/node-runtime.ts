import { spawn } from "node:child_process"
import { accessSync, constants } from "node:fs"
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { hostname } from "node:os"
import { delimiter, dirname, join } from "node:path"
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
        return true
      } catch {
        return false // the URL is printed for the person anyway
      }
    },
    // macOS adds .local, which says nothing about the machine.
    hostname: () => hostname().replace(/\.local$/, ""),
  }
}

/** Whether `file` is an executable on the PATH. */
function onPath(file: string, env: Runtime["env"]): boolean {
  return (env.PATH ?? "").split(delimiter).some((dir) => {
    try {
      accessSync(join(dir, file), constants.X_OK)
      return true
    } catch {
      return false
    }
  })
}

/**
 * How to open `url` in the default browser on this platform: none in an SSH
 * session, or (Linux and the like) without a display or without xdg-open,
 * where it would fail or start a text browser with no terminal. None means
 * the person opens the printed URL themselves, so it is never claimed open
 * when it can't be.
 */
export function browserCommand(
  url: string,
  platform: NodeJS.Platform,
  env: Runtime["env"],
  installed: (file: string) => boolean = (file) => onPath(file, env)
): { file: string; args: string[]; verbatim: boolean } | undefined {
  if (env.SSH_CONNECTION || env.SSH_TTY) return undefined
  if (platform === "darwin")
    return { file: "open", args: [url], verbatim: false }
  // start is cmd's own: cmd reads & | < > ^ ( ) as its own, so each is
  // escaped with ^; "" is start's window title, without which a quoted URL
  // would be taken for one. A % can't be escaped on cmd's command line (it
  // would expand %NAME%), so such a URL is only printed; sign-in URLs have none.
  if (platform === "win32")
    return url.includes("%")
      ? undefined
      : {
          file: "cmd",
          args: ["/c", "start", '""', url.replace(/[&|<>^()]/g, "^$&")],
          verbatim: true,
        }
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return undefined
  if (!installed("xdg-open")) return undefined
  return { file: "xdg-open", args: [url], verbatim: false }
}
