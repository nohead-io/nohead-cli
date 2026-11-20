import { homedir } from "node:os"
import { join } from "node:path"

import type { Runtime } from "./context.ts"
import { parseOwnFile } from "./input.ts"

/** A saved API key (`nohead login`), for the API it was checked against. */
export interface SavedKey {
  api_url: string
  api_key: string
  /** The key's name in the web app, for messages. */
  name?: string
}

/** Saved API keys by project ID: an API key belongs to one project. */
export interface ConfigFile {
  keys: Record<string, SavedKey>
}

/**
 * $NOHEAD_CONFIG, else $XDG_CONFIG_HOME/nohead/config.json, else
 * ~/.config/nohead/config.json. Without $HOME (Windows, some containers) ~ is
 * the user's home directory, never the current one.
 */
export function configPath(env: Runtime["env"]): string {
  if (env.NOHEAD_CONFIG) return env.NOHEAD_CONFIG
  // Empty counts as unset, as the XDG spec says.
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config")
  return join(base, "nohead", "config.json")
}

/** The saved keys, read now (login saves what is on disk when it saves). */
export async function readConfig(runtime: Runtime): Promise<ConfigFile> {
  return (await loadConfig(runtime))()
}

/**
 * The saved keys, read before any command runs; a broken file is only
 * reported to a command that asks for them, so it never stops `health`,
 * `--help` or NOHEAD_API_KEY.
 */
export async function loadConfig(runtime: Runtime): Promise<() => ConfigFile> {
  const path = configPath(runtime.env)
  let text: string
  try {
    text = await runtime.readFile(path)
  } catch {
    const none: ConfigFile = { keys: {} }
    return () => none
  }
  let config: ConfigFile
  try {
    const parsed = parseOwnFile(path, text) as { keys?: ConfigFile["keys"] }
    config = { keys: { ...parsed.keys } }
  } catch (error) {
    return () => {
      throw error
    }
  }
  return () => config
}

/**
 * The key saved for a project, if any. Own properties only: a project named
 * `constructor` or `__proto__` (from --project or a nohead.json) has no key.
 */
export function savedKey(
  config: ConfigFile,
  project: string
): SavedKey | undefined {
  return Object.hasOwn(config.keys, project) ? config.keys[project] : undefined
}

/** Written with owner-only permissions: it holds API keys. */
export async function writeConfig(runtime: Runtime, config: ConfigFile) {
  const path = configPath(runtime.env)
  await runtime.writePrivateFile(
    path,
    `${JSON.stringify({ keys: config.keys }, null, 2)}\n`
  )
  return path
}
