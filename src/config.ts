import { homedir } from "node:os"
import { join } from "node:path"

import type { Runtime } from "./context.ts"
import { usageError } from "./input.ts"

/**
 * Saved credentials (`nohead login`): a CLI session's token (`nohead_cli_…`,
 * from the browser) or an API key, the API it is for, and the project
 * commands work in unless told otherwise (`nohead use`).
 */
export interface Profile {
  api_url: string
  token: string
  project_id?: string
}

export interface ConfigFile {
  profiles: Record<string, Profile>
}

export const DEFAULT_PROFILE = "default"

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
    return { profiles: {} }
  }
  try {
    const parsed = JSON.parse(text) as {
      profiles?: Record<string, Profile & { api_key?: string }>
    }
    // Profiles saved before CLI sessions kept their API key as `api_key`.
    const profiles = Object.fromEntries(
      Object.entries(parsed.profiles ?? {}).map(([name, profile]) => {
        const { api_key, ...rest } = profile
        return [name, { ...rest, token: profile.token ?? api_key ?? "" }]
      })
    )
    return { profiles }
  } catch {
    throw usageError(`${path} is not valid JSON; fix or delete it`)
  }
}

/** Written with owner-only permissions: it holds tokens. */
export async function writeConfig(runtime: Runtime, config: ConfigFile) {
  const path = configPath(runtime.env)
  await runtime.writePrivateFile(path, `${JSON.stringify(config, null, 2)}\n`)
  return path
}
