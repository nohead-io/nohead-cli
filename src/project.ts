import { dirname, join } from "node:path"

import { savedKey, type ConfigFile } from "./config.ts"
import { envVar, origin, type GlobalOptions, type Runtime } from "./context.ts"
import { usageError } from "./input.ts"

/** The file `nohead link` writes: a folder's project, with no secret in it. */
export const LINK_FILE = "nohead.json"

/** The nearest nohead.json, read (or why it could not be). */
export interface LinkFile {
  path: string
  text?: string
  error?: string
}

/**
 * The nohead.json in the current directory or the nearest one above it, as
 * git finds .git. Read before any command runs, but only checked when a
 * command uses it, so a broken one never stops `health` or `--project`.
 */
export async function findLinkFile(
  runtime: Runtime
): Promise<LinkFile | undefined> {
  for (let dir = runtime.cwd(); ; dir = dirname(dir)) {
    const path = join(dir, LINK_FILE)
    try {
      return { path, text: await runtime.readFile(path) }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "ENOENT" && code !== "ENOTDIR")
        return { path, error: (error as Error).message }
    }
    if (dirname(dir) === dir) return undefined
  }
}

/** A nohead.json's contents: any JSON object (other keys are kept). */
export function parseLinkFile(path: string, text: string) {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw usageError(`${path} is not valid JSON; fix or delete it`)
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw usageError(`${path} is not a JSON object; fix or delete it`)
  return parsed as Record<string, unknown>
}

/** The project a nohead.json links to. */
function linkedProject(link: LinkFile): string {
  if (link.error) throw usageError(`Cannot read ${link.path}: ${link.error}`)
  const { project } = parseLinkFile(link.path, link.text ?? "")
  if (typeof project !== "string" || !project)
    throw usageError(
      `${link.path} names no project; run \`nohead link <project>\` or delete it`
    )
  return project
}

/** Where the project in use comes from, as `whoami --json` says. */
export type ProjectSource =
  | "--project"
  | "NOHEAD_PROJECT"
  | "nohead.json"
  | "only_saved_key"
  | "NOHEAD_API_KEY"

/** Where the project in use came from, for a person. */
export function describeSource({ source, linkFile }: ProjectChoice): string {
  switch (source) {
    case "nohead.json":
      return linkFile ?? source
    case "only_saved_key":
      return "the only saved key"
    default:
      return source
  }
}

export interface ProjectChoice {
  source: ProjectSource
  /** Unset for NOHEAD_API_KEY's own project, which only the API knows. */
  project?: string
  /** The nohead.json the project came from. */
  linkFile?: string
}

/**
 * The project to work in, which for a saved key also chooses the key:
 * --project, then NOHEAD_PROJECT, then the nearest nohead.json, then the only
 * saved key (for `apiUrl` when one is given). NOHEAD_API_KEY brings its own
 * project, so a folder's nohead.json does not apply to it. Undefined when no
 * key is saved: not logged in.
 */
export function chooseProject({
  options,
  env,
  config,
  link,
  apiUrl,
  envApiKey,
}: {
  options: Pick<GlobalOptions, "project">
  env: Runtime["env"]
  config: ConfigFile
  link?: LinkFile
  apiUrl?: string
  envApiKey?: string
}): ProjectChoice | undefined {
  if (options.project) return { source: "--project", project: options.project }
  const fromEnv = envVar(env, "NOHEAD_PROJECT")
  if (fromEnv) return { source: "NOHEAD_PROJECT", project: fromEnv }
  if (envApiKey) return { source: "NOHEAD_API_KEY" }
  if (link)
    return {
      source: "nohead.json",
      project: linkedProject(link),
      linkFile: link.path,
    }

  const saved = Object.keys(config.keys).filter(
    (id) => !apiUrl || origin(config.keys[id].api_url) === origin(apiUrl)
  )
  if (saved.length === 1) return { source: "only_saved_key", project: saved[0] }
  if (saved.length === 0) {
    if (apiUrl && Object.keys(config.keys).length > 0)
      throw usageError(
        `No API key saved for ${apiUrl}. Run \`nohead login\` with one of its API keys, or set NOHEAD_API_KEY.`
      )
    return undefined
  }
  const list = saved
    .map((id) => {
      const { name } = config.keys[id]
      return name ? `${id} (${name})` : id
    })
    .join(", ")
  throw usageError(
    `API keys are saved for several projects: ${list}. Choose one: pass --project, set NOHEAD_PROJECT, or run \`nohead link <project>\` in this folder.`
  )
}

/** The saved key for a chosen project, or why there is none. */
export function savedKeyFor(config: ConfigFile, choice: ProjectChoice) {
  const key = choice.project ? savedKey(config, choice.project) : undefined
  if (key) return key
  const linked = choice.linkFile ? `, which ${choice.linkFile} links to` : ""
  throw usageError(
    `No API key saved for project ${choice.project}${linked}. Run \`nohead login\` with one of that project's API keys (from the web app), or set NOHEAD_API_KEY.`
  )
}
