import { APIError, ConnectionError, UploadError } from "@nohead/sdk"

/**
 * Exit codes are part of the CLI's compatibility surface for scripts and agents.
 */
export const ExitCode = {
  Success: 0,
  /** The API returned an error (validation, auth, not found, ...). */
  ApiError: 1,
  /** Invalid or missing arguments. */
  Usage: 2,
  /** The API could not be reached. */
  Network: 3,
  /** The CLI itself failed unexpectedly (a bug; please report it). */
  Internal: 4,
} as const

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode]

/** Mirrors the API error envelope so --json output is consistent. */
export interface ErrorBody {
  type: string
  message: string
  request_id?: string
  /** As the API sends them, with any extra keys (usage, current_revision, ...). */
  details?: APIError["details"]
}

export class CliError extends Error {
  readonly exitCode: ExitCode
  readonly body: ErrorBody

  constructor(exitCode: ExitCode, body: ErrorBody) {
    super(body.message)
    this.exitCode = exitCode
    this.body = body
  }
}

/** Awaits an SDK call, turning its errors into CliErrors. */
export async function unwrap<T>(call: PromiseLike<T>): Promise<T> {
  try {
    return await call
  } catch (error) {
    throw cliError(error)
  }
}

/** The API key may not do this (authorization_error); some commands go on without it. */
export function isForbidden(error: unknown): error is CliError {
  return error instanceof CliError && error.body.type === "authorization_error"
}

/**
 * The error of one item among many (a line or record being imported), to
 * report with the others and go on. Anything else stops the command: an
 * API that cannot be reached, or a bug.
 */
export function itemError(error: unknown): ErrorBody {
  if (!(error instanceof CliError) || error.exitCode === ExitCode.Network)
    throw error
  return error.body
}

/** The first item of an SDK list that matches, reading pages until it does. */
export async function unwrapFind<T>(
  items: AsyncIterable<T>,
  match: (item: T) => boolean
): Promise<T | undefined> {
  try {
    for await (const item of items) if (match(item)) return item
  } catch (error) {
    throw cliError(error)
  }
  return undefined
}

/**
 * An SDK error as a CliError; anything else is returned as it is. The
 * browser sign-in's endpoints, which the SDK does not call, build their
 * answers into SDK errors to come out the same way.
 */
export function cliError(error: APIError | ConnectionError): CliError
export function cliError(error: unknown): unknown
export function cliError(error: unknown): unknown {
  if (error instanceof APIError) {
    // The SDK reads the error envelope: a type means the body was one.
    if (error.type === undefined)
      return new CliError(ExitCode.ApiError, {
        type: "internal_error",
        message: `Unexpected API response (HTTP ${error.status})`,
      })
    // As the API sends it: in this order, details only when there are some.
    // The API's own message: the SDK's `message` adds the status, type and
    // request ID, which the CLI prints on their own.
    const { type, apiMessage, requestId, details } = error
    return new CliError(ExitCode.ApiError, {
      type,
      message: apiMessage,
      request_id: requestId,
      ...(details.length > 0 && { details }),
    })
  }
  // Storage could not be reached (the cause), or refused the bytes.
  if (error instanceof UploadError)
    return error.cause
      ? storageUnreachable(error.cause)
      : new CliError(ExitCode.ApiError, {
          type: "upload_failed",
          message: error.message,
        })
  if (error instanceof ConnectionError) return networkError(fetchFailure(error))
  return error
}

/** Storage, where files go up and come down, could not be reached. */
export function storageUnreachable(cause: unknown): CliError {
  return new CliError(ExitCode.Network, {
    type: "network_error",
    message: `Could not reach storage: ${reason(fetchFailure(cause))}`,
  })
}

function networkError(cause: unknown) {
  return new CliError(ExitCode.Network, {
    type: "network_error",
    message: `Could not reach the API: ${reason(cause)}`,
  })
}

// The SDK's message names the host; the CLI's names the fetch failure.
function fetchFailure(error: unknown): unknown {
  return error instanceof ConnectionError ? (error.cause ?? error) : error
}

function reason(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
