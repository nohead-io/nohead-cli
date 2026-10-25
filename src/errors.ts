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

/** Every item of an SDK list, across its pages. */
export async function unwrapAll<T>(items: AsyncIterable<T>): Promise<T[]> {
  const all: T[] = []
  try {
    for await (const item of items) all.push(item)
  } catch (error) {
    throw cliError(error)
  }
  return all
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

function cliError(error: unknown): unknown {
  if (error instanceof APIError) {
    // The SDK reads the error envelope: a type means the body was one.
    if (error.type === undefined)
      return new CliError(ExitCode.ApiError, {
        type: "internal_error",
        message: `Unexpected API response (HTTP ${error.status})`,
      })
    // As the API sends it: in this order, details only when there are some.
    const { type, message, requestId, details } = error
    return new CliError(ExitCode.ApiError, {
      type,
      message,
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
