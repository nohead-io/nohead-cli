import { VERSION as SDK_VERSION } from "@nohead/sdk"
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
import { CliError, ExitCode, type ErrorBody } from "./errors.ts"
import { printError } from "./output.ts"
import { VERSION } from "./version.ts"

export { VERSION }

function buildProgram(runtime: Runtime, config: ConfigFile, json: boolean) {
  const program = new Command()
    .name("nohead")
    .description(
      "Manage Nohead collections, fields and records from the command line"
    )
    // The SDK it calls the API through too, for bug reports. The CLI's own
    // version comes first, so scripts can read the first word.
    .version(`${VERSION} (SDK ${SDK_VERSION})`)
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
    // Subcommands copy these settings when .command() makes them, so they
    // are set before any command is registered.
    .showHelpAfterError()
    .exitOverride()
    .configureOutput({
      writeOut: runtime.stdout,
      // With --json, stderr carries only the error document run() prints.
      writeErr: json ? () => {} : runtime.stderr,
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

  return program
}

/** Runs the CLI and resolves to the process exit code. Never calls process.exit. */
export async function run(argv: string[], runtime: Runtime): Promise<number> {
  // Usage errors stop commander before it has read --json.
  const json = argv.includes("--json")
  let program: Command | undefined
  try {
    program = buildProgram(runtime, await readConfig(runtime), json)
    await program.parseAsync(argv, { from: "user" })
    return ExitCode.Success
  } catch (error) {
    if (error instanceof CommanderError) {
      // --help and --version exit through here with code 0.
      if (error.exitCode === 0) return ExitCode.Success
      // Commander printed the error and the help, except with --json.
      if (json) printError(runtime, true, usage(error))
      return ExitCode.Usage
    }
    const cliError = error instanceof CliError ? error : unexpected(error)
    printError(
      runtime,
      program?.opts<GlobalOptions>().json ?? json,
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
 * A commander error as the CLI's own usage errors read: "missing required
 * argument 'id'". A command given no subcommand shows its help instead of an
 * error message.
 */
function usage(error: CommanderError): ErrorBody {
  return {
    type: "invalid_request",
    message:
      error.code === "commander.help"
        ? "missing command; see --help"
        : error.message.replace(/^error: /, ""),
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

/** An argument, an option or a command, as `commands.json` describes it. */
export interface DescribedArgument {
  name: string
  description: string
  required: boolean
  variadic: boolean
  choices?: string[]
}
export interface DescribedOption {
  flags: string
  description: string
  default?: unknown
  choices?: string[]
}
export interface DescribedCommand {
  name: string
  usage: string
  description: string
  arguments: DescribedArgument[]
  options: DescribedOption[]
  commands: DescribedCommand[]
}

/**
 * Every command, with its arguments and options, as commander knows them:
 * what `commands.json` holds for the docs' CLI reference. Built with an inert
 * runtime, so nothing is read, fetched or written.
 */
export function describeCommands(): DescribedCommand {
  const refuse = () =>
    Promise.reject(new Error("describeCommands does no input or output"))
  const inert: Runtime = {
    stdout: () => {},
    stderr: () => {},
    env: {},
    fetch: refuse,
    readFile: refuse,
    readBinaryFile: refuse,
    writeFile: refuse,
    readStdin: refuse,
    stdinIsTTY: false,
    readSecret: refuse,
    writePrivateFile: refuse,
    sleep: () => Promise.resolve(),
    now: () => new Date(0),
  }
  return describe(buildProgram(inert, { profiles: {} }, false))
}

function describe(command: Command): DescribedCommand {
  return {
    name: command.name(),
    usage: command.usage(),
    description: command.description(),
    arguments: command.registeredArguments.map((argument) => ({
      name: argument.name(),
      description: argument.description,
      required: argument.required,
      variadic: argument.variadic,
      ...(argument.argChoices ? { choices: argument.argChoices } : {}),
    })),
    options: command.options
      .filter((option) => !option.hidden)
      .map((option) => ({
        flags: option.flags,
        description: option.description,
        ...(option.defaultValue === undefined
          ? {}
          : { default: option.defaultValue as unknown }),
        ...(option.argChoices ? { choices: option.argChoices } : {}),
      })),
    commands: command.commands
      .filter((sub) => sub.name() !== "help")
      .map(describe),
  }
}
