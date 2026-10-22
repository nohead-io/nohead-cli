import { Command, CommanderError } from "commander"

import { registerAssets } from "./commands/assets.ts"
import { registerCollections } from "./commands/collections.ts"
import { registerDrafts } from "./commands/drafts.ts"
import { registerFields } from "./commands/fields.ts"
import { registerFlags } from "./commands/flags.ts"
import { registerHealth } from "./commands/health.ts"
import { registerMigrations } from "./commands/migrations.ts"
import { registerPortability } from "./commands/portability.ts"
import { registerRecords } from "./commands/records.ts"
import { registerSchema } from "./commands/schema.ts"
import { registerSearch } from "./commands/search.ts"
import { registerLogin } from "./commands/login.ts"
import { registerWebhooks } from "./commands/webhooks.ts"
import { registerAudit } from "./commands/audit.ts"
import { registerWhoami } from "./commands/whoami.ts"
import { readConfig, type ConfigFile } from "./config.ts"
import {
  createContext,
  type CommandContext,
  type GlobalOptions,
  type Runtime,
} from "./context.ts"
import { CliError, ExitCode } from "./errors.ts"
import { printError } from "./output.ts"
import { VERSION } from "./version.ts"

export { VERSION }

function buildProgram(runtime: Runtime, config: ConfigFile) {
  const program = new Command()
    .name("nohead")
    .description(
      "Manage Nohead collections, fields and records from the command line"
    )
    .version(VERSION)
    .option("--json", "print machine-readable JSON on stdout", false)
    .option("--api-url <url>", "API base URL (default: $NOHEAD_API_URL)")
    .option(
      "--project <id>",
      "project ID (default: $NOHEAD_PROJECT, or the API key's project)"
    )
    .option(
      "--profile <name>",
      "saved credentials to use (default: $NOHEAD_PROFILE or default)"
    )
    .option(
      "--note <text>",
      "reason for the change, kept in the history of records and the schema"
    )
    .option(
      "--idempotency-key <key>",
      "makes retrying a mutation safe: the same key and request return the first result"
    )
    .showHelpAfterError()
    .exitOverride()
    .configureOutput({
      writeOut: runtime.stdout,
      writeErr: runtime.stderr,
    })

  const context = (): CommandContext =>
    createContext(runtime, program.opts<GlobalOptions>(), config)

  registerHealth(program, context)
  registerWhoami(program, context)
  registerLogin(program, context)
  registerCollections(program, context)
  registerFields(program, context)
  registerMigrations(program, context)
  registerRecords(program, context)
  registerDrafts(program, context)
  registerAssets(program, context)
  registerFlags(program, context)
  registerSchema(program, context)
  registerSearch(program, context)
  registerWebhooks(program, context)
  registerAudit(program, context)
  registerPortability(program, context)

  // Subcommands inherit the parent's error handling and output streams.
  const propagate = (command: Command) => {
    for (const sub of command.commands) {
      sub
        .exitOverride()
        .configureOutput({ writeOut: runtime.stdout, writeErr: runtime.stderr })
      propagate(sub)
    }
  }
  propagate(program)

  return program
}

/** Runs the CLI and resolves to the process exit code. Never calls process.exit. */
export async function run(argv: string[], runtime: Runtime): Promise<number> {
  let program: Command | undefined
  try {
    program = buildProgram(runtime, await readConfig(runtime))
    await program.parseAsync(argv, { from: "user" })
    return ExitCode.Success
  } catch (error) {
    if (error instanceof CommanderError) {
      // --help and --version exit through here with code 0.
      return error.exitCode === 0 ? ExitCode.Success : ExitCode.Usage
    }
    const cliError = error instanceof CliError ? error : unexpected(error)
    printError(
      runtime,
      program?.opts<GlobalOptions>().json ?? argv.includes("--json"),
      cliError.body
    )
    if (!(error instanceof CliError) && runtime.env.NOHEAD_DEBUG)
      runtime.stderr(
        `${error instanceof Error ? error.stack : String(error)}\n`
      )
    return cliError.exitCode
  }
}

/**
 * Errors that are not the API's: files that cannot be read or written are
 * usage errors; anything else is a bug, still reported in the usual shape
 * (NOHEAD_DEBUG=1 adds the stack).
 */
function unexpected(error: unknown): CliError {
  const system = error as NodeJS.ErrnoException
  if (error instanceof Error && typeof system.code === "string" && system.path)
    return new CliError(ExitCode.Usage, {
      type: "invalid_request",
      message: `${system.path}: ${error.message}`,
    })
  return new CliError(ExitCode.Internal, {
    type: "internal_error",
    message: `Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
  })
}
