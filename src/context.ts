import { Nohead, type RequestOptions } from "@nohead/sdk"

import { savedKey, type ConfigFile } from "./config.ts"
import { CliError, ExitCode, unwrap } from "./errors.ts"
import {
  chooseProject,
  savedKeyFor,
  type LinkFile,
  type ProjectChoice,
} from "./project.ts"
import { VERSION } from "./version.ts"

export const DEFAULT_API_URL = "https://api.nohead.io"

export const origin = (url: string) => URL.parse(url)?.origin ?? url

/**
 * API keys travel over https, except to this machine or a development host
 * (localhost, *.localhost, *.test): anyone on the path could read them.
 */
export function requireSecureUrl(url: string) {
  const { protocol, hostname } = URL.parse(url) ?? {
    protocol: "",
    hostname: "",
  }
  const local =
    ["localhost", "127.0.0.1", "[::1]"].includes(hostname) ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".test")
  if (protocol === "https:" || (protocol === "http:" && local)) return
  throw new CliError(ExitCode.Usage, {
    type: "invalid_request",
    message: `Refusing to send an API key to ${url}: use https`,
  })
}

/**
 * An environment variable's value, with an empty one counting as unset (as in
 * the SDKs): `NOHEAD_API_KEY=` in an .envrc must not hide the saved keys.
 */
export function envVar(
  env: Runtime["env"],
  name: `NOHEAD_${string}`
): string | undefined {
  return env[name] || undefined
}

/** Process boundary the CLI runs against, injectable for tests. */
export interface Runtime {
  stdout: (text: string) => void
  stderr: (text: string) => void
  env: Record<string, string | undefined>
  /** The current directory, where `nohead link` writes nohead.json. */
  cwd: () => string
  fetch: typeof globalThis.fetch
  readFile: (path: string) => Promise<string>
  readBinaryFile: (path: string) => Promise<Uint8Array>
  /**
   * Creates missing directories. `exclusive` fails with code EEXIST rather
   * than replace an existing file.
   */
  writeFile: (
    path: string,
    content: string | Uint8Array,
    options?: { exclusive?: boolean }
  ) => Promise<void>
  readStdin: () => Promise<string>
  /** Whether stdin is an interactive terminal (nothing piped in). */
  stdinIsTTY: boolean
  /**
   * A line from the interactive terminal, not echoed (a secret), after
   * writing `prompt` to stderr. Only when stdinIsTTY.
   */
  readSecret: (prompt: string) => Promise<string>
  /** Writes a file only the current user can read, creating directories. */
  writePrivateFile: (path: string, content: string) => Promise<void>
  sleep: (ms: number) => Promise<void>
  /** The current time (injectable so relative times are testable). */
  now: () => Date
}

export interface GlobalOptions {
  json: boolean
  apiUrl?: string
  project?: string
  note?: string
  idempotencyKey?: string
}

export interface CommandContext {
  runtime: Runtime
  options: GlobalOptions
  /**
   * The API client. Reading it checks the credentials, so commands that make
   * no request never fail for want of a key.
   */
  readonly api: Nohead
  /**
   * The client for the project to work in (`projectId`), for operations on
   * the project: its collections, assets, webhooks, search and activity log.
   */
  project: () => Promise<Nohead>
  /** The client for public operations (`health`), without the API key. */
  readonly publicApi: Nohead
  /** The API's base URL. */
  baseUrl: string
  /** Where the API key comes from, for `whoami`. */
  credentials: string
  /**
   * The project to work in: --project, $NOHEAD_PROJECT, nohead.json, the
   * only saved key's, or NOHEAD_API_KEY's own.
   */
  projectId: () => Promise<string>
  /** Where the project comes from (chooseProject), for `whoami`. */
  projectChoice: () => ProjectChoice | undefined
  /**
   * The project whose saved key a command would use, whatever
   * NOHEAD_API_KEY says (`login`, `logout`).
   */
  savedProjectChoice: () => ProjectChoice | undefined
  /** The nearest nohead.json, unchecked. */
  link?: LinkFile
  /**
   * Options for mutations: the --note, recorded in history, and an
   * Idempotency-Key (--idempotency-key, or one the command derives; null:
   * one the SDK makes up for each request).
   */
  writeOptions: (idempotencyKey?: string | null) => RequestOptions
}

/**
 * An SDK client as the CLI uses it. The SDK retries what is safe to retry
 * (429 after Retry-After, network failures and 5xx with backoff; every write
 * carries an Idempotency-Key), and `notify` says so on stderr.
 */
export function createApi(options: {
  baseUrl: string
  apiKey: string
  fetch: typeof globalThis.fetch
  projectId?: string
  notify?: (message: string) => void
}): Nohead {
  const { notify = () => {}, ...client } = options
  const api = origin(options.baseUrl)
  return new Nohead({
    ...client,
    // The runtime's fetch takes a Request.
    fetch: (input, init) => options.fetch(new Request(input, init)),
    headers: { "Nohead-Client": `cli/${VERSION}` },
    // The SDK's per-attempt timeout (60 s) for API calls; uploads set their
    // own from the file's size (uploadAsset).
    maxRetries: 3,
    // They would go to stderr past the runtime, and into --json output.
    warnings: false,
    onRetry: ({ delay, status, url }) => {
      const service = origin(url) === api ? "the API" : "storage"
      notify(
        status === 429
          ? `Rate limited; retrying in ${Math.ceil(delay)}s\n`
          : status === undefined
            ? `Could not reach ${service}; retrying\n`
            : `${service === "the API" ? "API" : "Storage"} unavailable (HTTP ${status}); retrying\n`
      )
    },
  })
}

/**
 * Settings resolve flags first, then environment variables, then what is
 * saved: the key `nohead login` saved for the project chosen (chooseProject).
 */
export function createContext(
  runtime: Runtime,
  options: GlobalOptions,
  config: ConfigFile = { keys: {} },
  link?: LinkFile
): CommandContext {
  const envApiKey = envVar(runtime.env, "NOHEAD_API_KEY")
  const apiUrl = options.apiUrl ?? envVar(runtime.env, "NOHEAD_API_URL")
  // Chosen now, so the API URL can follow the saved key, but only reported
  // when a command needs it: `health` works whatever is saved.
  const choose = (withEnvKey: boolean) =>
    chooseProject({
      options,
      env: runtime.env,
      config,
      link,
      apiUrl,
      envApiKey: withEnvKey ? envApiKey : undefined,
    })
  let choice: ProjectChoice | undefined
  let choiceError: Error | undefined
  try {
    choice = choose(true)
  } catch (error) {
    choiceError = error as Error
  }
  const projectChoice = () => {
    if (choiceError) throw choiceError
    return choice
  }
  const saved =
    !envApiKey && choice?.project ? savedKey(config, choice.project) : undefined
  const baseUrl = apiUrl ?? saved?.api_url ?? DEFAULT_API_URL
  const credentials = envApiKey
    ? "NOHEAD_API_KEY"
    : saved
      ? "saved key"
      : "none"
  const fetch = runtime.fetch
  // With --json, stderr carries only the final error document.
  const notify = options.json ? () => {} : runtime.stderr
  const authenticatedKey = () => {
    if (envApiKey) {
      requireSecureUrl(baseUrl)
      return envApiKey
    }
    const chosen = projectChoice()
    if (!chosen) {
      throw new CliError(ExitCode.Usage, {
        type: "invalid_request",
        message:
          "Not logged in. Run `nohead login` with an API key from the web app (API keys), or set NOHEAD_API_KEY.",
      })
    }
    const key = savedKeyFor(config, chosen)
    // A saved key only goes to the API it was saved for: a NOHEAD_API_URL
    // from some project's .envrc must not receive it.
    if (origin(key.api_url) !== origin(baseUrl)) {
      throw new CliError(ExitCode.Usage, {
        type: "invalid_request",
        message: `The API key saved for project ${chosen.project} is for ${key.api_url}, not ${baseUrl}. Set NOHEAD_API_KEY to use another API.`,
      })
    }
    requireSecureUrl(baseUrl)
    return key.api_key
  }

  let api: Nohead | undefined
  let publicApi: Nohead | undefined
  let projectApi: Promise<Nohead> | undefined
  let project: Promise<string> | undefined
  const projectId = () =>
    (project ??= (async () => {
      const chosen = projectChoice()?.project
      if (chosen) return chosen

      // NOHEAD_API_KEY's own project (or not logged in, which context.api
      // reports).
      const me = await unwrap(context.api.me.get())
      if (!me.api_key) {
        throw new CliError(ExitCode.Usage, {
          type: "invalid_request",
          message:
            "Pass --project (or set NOHEAD_PROJECT) when not using a project API key.",
        })
      }
      return me.api_key.project_id
    })())

  const writeOptions = (
    idempotencyKey: string | null | undefined = options.idempotencyKey
  ): RequestOptions => ({
    ...(options.note ? { changeNote: options.note } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  })

  const context: CommandContext = {
    runtime,
    options,
    get api() {
      return (api ??= createApi({
        baseUrl,
        apiKey: authenticatedKey(),
        fetch,
        notify,
      }))
    },
    project: () =>
      (projectApi ??= projectId().then((id) =>
        createApi({
          baseUrl,
          apiKey: authenticatedKey(),
          fetch,
          notify,
          projectId: id,
        })
      )),
    // The SDK always sends a key: health gets a placeholder, never the real
    // one, which might be going over http.
    get publicApi() {
      return (publicApi ??= createApi({
        baseUrl,
        apiKey: "none",
        fetch,
        notify,
      }))
    },
    baseUrl,
    credentials,
    projectId,
    projectChoice,
    savedProjectChoice: () => choose(false),
    link,
    writeOptions,
  }
  return context
}
