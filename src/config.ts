import { homedir } from "node:os"
import { join } from "node:path"

import { DEFAULT_API_URL, type Runtime } from "./context.ts"
import { usageError } from "./input.ts"

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

/** The shape before keys were saved by project: named profiles. */
interface Profile {
  api_url?: string
  api_key?: string
  project_id?: string
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

export async function readConfig(runtime: Runtime): Promise<ConfigFile> {
  const path = configPath(runtime.env)
  let text: string
  try {
    text = await runtime.readFile(path)
  } catch {
    return { keys: {} }
  }
  let parsed: { keys?: ConfigFile["keys"]; profiles?: Record<string, Profile> }
  try {
    parsed = JSON.parse(text) as typeof parsed
  } catch {
    throw usageError(`${path} is not valid JSON; fix or delete it`)
  }
  return { keys: { ...fromProfiles(parsed.profiles), ...parsed.keys } }
}

/**
 * Keys saved as profiles, by their project: the next write saves them in the
 * new shape. A profile without a project (or key) has nothing to go under.
 */
function fromProfiles(profiles: Record<string, Profile> = {}) {
  const keys: ConfigFile["keys"] = {}
  for (const { api_url, api_key, project_id } of Object.values(profiles)) {
    if (!project_id || !api_key || project_id in keys) continue
    // Profiles saved before the URL was recorded were for the default API.
    keys[project_id] = { api_url: api_url ?? DEFAULT_API_URL, api_key }
  }
  return keys
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
