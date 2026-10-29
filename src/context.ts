import { Nohead, type RequestOptions } from "@nohead/sdk"

import { DEFAULT_PROFILE, type ConfigFile } from "./config.ts"
import { CliError, ExitCode, unwrap } from "./errors.ts"
import { VERSION } from "./version.ts"

export const DEFAULT_API_URL = "https://api.nohead.io"

const origin = (url: string) => URL.parse(url)?.origin ?? url

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
 * the SDKs): `NOHEAD_API_KEY=` in an .envrc must not hide the saved profile.
 */
export function envVar(
  env: Runtime["env"],
  name: `NOHEAD_${string}`
): string | undefined {
  return env[name] || undefined
}

/** The profile a command uses: --profile, then NOHEAD_PROFILE, then the default. */
export function profileName(
  options: { profile?: string },
  env: Runtime["env"]
): string {
  return options.profile ?? envVar(env, "NOHEAD_PROFILE") ?? DEFAULT_PROFILE
}

/** Process boundary the CLI runs against, injectable for tests. */
export interface Runtime {
  stdout: (text: string) => void
  stderr: (text: string) => void
  env: Record<string, string | undefined>
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
  profile?: string
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
  /** The project to work in: --project, $NOHEAD_PROJECT, or the API key's own. */
  projectId: () => Promise<string>
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
 * Settings resolve flags first, then environment variables, then the saved
 * profile (`nohead login`; --profile or $NOHEAD_PROFILE, else "default").
 */
export function createContext(
  runtime: Runtime,
  options: GlobalOptions,
  config: ConfigFile = { profiles: {} }
): CommandContext {
  const envApiKey = envVar(runtime.env, "NOHEAD_API_KEY")
  const name = profileName(options, runtime.env)
  const profile = config.profiles[name]
  // A named profile that does not exist yet is fine for `login`, which
  // creates it; any command that needs credentials fails here instead.
  const missingProfile =
    !profile &&
    Boolean(options.profile || envVar(runtime.env, "NOHEAD_PROFILE"))
  const baseUrl =
    options.apiUrl ??
    envVar(runtime.env, "NOHEAD_API_URL") ??
    profile?.api_url ??
    DEFAULT_API_URL
  // A saved key only goes to the API it was saved for: a NOHEAD_API_URL
  // from some project's .envrc must not receive it.
  const savedUrl = profile ? (profile.api_url ?? DEFAULT_API_URL) : undefined
  const profileKey =
    savedUrl && origin(savedUrl) === origin(baseUrl)
      ? profile?.api_key
      : undefined
  const apiKey = envApiKey ?? profileKey
  const credentials = envApiKey
    ? "NOHEAD_API_KEY"
    : profileKey
      ? `profile ${name}`
      : "none"
  const fetch = runtime.fetch
  // With --json, stderr carries only the final error document.
  const notify = options.json ? () => {} : runtime.stderr
  const authenticatedKey = () => {
    if (missingProfile && !envApiKey) {
      throw new CliError(ExitCode.Usage, {
        type: "invalid_request",
        message: `No saved profile "${name}". Run: nohead login --profile ${name}`,
      })
    }
    if (!apiKey && profile?.api_key) {
      throw new CliError(ExitCode.Usage, {
        type: "invalid_request",
        message: `Profile "${name}" holds a key for ${savedUrl}, not ${baseUrl}. Set NOHEAD_API_KEY to use another API.`,
      })
    }
    if (!apiKey) {
      throw new CliError(ExitCode.Usage, {
        type: "invalid_request",
        message:
          "Not logged in. Run `nohead login` with an API key from the web app (API keys), or set NOHEAD_API_KEY.",
      })
    }
    requireSecureUrl(baseUrl)
    return apiKey
  }

  let api: Nohead | undefined
  let publicApi: Nohead | undefined
  let projectApi: Promise<Nohead> | undefined
  let project: Promise<string> | undefined
  const projectId = () =>
    (project ??= (async () => {
      const explicit =
        options.project ??
        envVar(runtime.env, "NOHEAD_PROJECT") ??
        (envApiKey ? undefined : profile?.project_id)
      if (explicit) return explicit

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
    writeOptions,
  }
  return context
}
