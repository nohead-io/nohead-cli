import type { Command } from "commander"

import { browserLogin, type ApprovedLogin } from "../browser-login.ts"
import { configPath, readConfig, savedKey, writeConfig } from "../config.ts"
import {
  createApi,
  DEFAULT_API_URL,
  envVar,
  requireSecureUrl,
  type CommandContext,
} from "../context.ts"
import { unwrap } from "../errors.ts"
import { usageError } from "../input.ts"
import { printNotice, printResult } from "../output.ts"
import { describeSource } from "../project.ts"

export function registerLogin(program: Command, context: () => CommandContext) {
  program
    .command("login")
    .description(
      "Sign in with the browser and save an API key for the project you choose; a key piped in is checked and saved as it is (echo $KEY | nohead login)"
    )
    .action(async () => {
      const ctx = context()
      const { runtime, options } = ctx
      const apiUrl =
        options.apiUrl ??
        envVar(runtime.env, "NOHEAD_API_URL") ??
        DEFAULT_API_URL

      // A key piped in (echo $KEY | nohead login), as CI does, is checked
      // and saved. Otherwise, at a terminal or with nothing on stdin (a
      // coding agent), the person signs in with the browser, which makes a
      // key for the project they choose, or for the one this folder (or
      // --project, NOHEAD_PROJECT) uses, if it uses one.
      const raw = runtime.stdinIsTTY ? "" : await runtime.readStdin()
      const piped = raw.trim()
      // Something piped in that holds no key is a mistake (an unset
      // variable in `echo "$KEY"`), not a person waiting to sign in; and
      // in CI there is no one to approve a browser sign-in.
      if (raw && !piped)
        throw usageError("No API key given on stdin (is the variable set?)")
      if (!piped && runtime.env.CI)
        throw usageError(
          "No API key given: in CI, set NOHEAD_API_KEY (or pipe a key in) instead of signing in with the browser"
        )
      requireSecureUrl(apiUrl)
      const { token, api_key } = piped
        ? await checkKey(apiUrl, piped, runtime.fetch)
        : await browserLogin(ctx, apiUrl, wantedProject(ctx)?.project)

      const project = api_key.project_id
      const config = await readConfig(runtime)
      // One key per project: logging in again for it replaces the old one.
      const replaced = savedKey(config, project) !== undefined
      config.keys[project] = {
        api_url: apiUrl,
        api_key: token,
        name: api_key.name,
      }
      const path = await writeConfig(runtime, config)
      const result = {
        api_url: apiUrl,
        project_id: project,
        api_key: { id: api_key.id, name: api_key.name },
        replaced,
        config: path,
      }
      printResult(ctx, result, () =>
        [
          `Logged in to ${apiUrl} with API key ${api_key.name} (project ${project}).`,
          `${replaced ? "Replaced the saved key" : "Saved the key"} for project ${project} in ${path}.`,
        ].join("\n")
      )
      // The key went under its own project, which may not be the one this
      // folder (or --project, NOHEAD_PROJECT) asks for.
      const wanted = wantedProject(ctx)
      if (wanted && wanted.project !== project && !options.json)
        printNotice(
          ctx,
          `Commands here use project ${wanted.project} (from ${describeSource(wanted)}), not ${project}: log in to it too, or choose ${project} with --project.`
        )
      if (envVar(runtime.env, "NOHEAD_API_KEY") && !options.json)
        printNotice(
          ctx,
          "NOHEAD_API_KEY is set, so commands use it rather than the saved key until you unset it."
        )
    })

  program
    .command("logout")
    .description(
      "Forget the API key saved for the project in use (the key itself stays valid; revoke it in the web app)"
    )
    .action(async () => {
      const ctx = context()
      const { runtime } = ctx
      const config = await readConfig(runtime)
      const project = ctx.savedProjectChoice()?.project
      const key = project ? savedKey(config, project) : undefined
      if (project && key) {
        delete config.keys[project]
        await writeConfig(runtime, config)
      }
      printResult(
        ctx,
        { project_id: project ?? null, removed: Boolean(key) },
        () =>
          !project
            ? "No API keys are saved."
            : key
              ? `Forgot the API key${key.name ? ` ${key.name}` : ""} saved for project ${project} (${configPath(runtime.env)}). The key stays valid until you revoke it in the web app.`
              : `No API key saved for project ${project}.`
      )
    })
}

/** A key piped in, checked before it is saved. */
async function checkKey(
  apiUrl: string,
  apiKey: string,
  fetch: CommandContext["runtime"]["fetch"]
): Promise<ApprovedLogin> {
  const api = createApi({ baseUrl: apiUrl, apiKey, fetch })
  const me = await unwrap(api.me.get())
  if (!me.api_key)
    throw usageError(
      "That is not a project API key; log in with one from the web app (API keys)"
    )
  return { token: apiKey, api_key: me.api_key }
}

/**
 * The project chosen for this folder (--project, NOHEAD_PROJECT or the
 * nearest nohead.json), if one is, before this login.
 */
function wantedProject(ctx: CommandContext) {
  try {
    const choice = ctx.savedProjectChoice()
    return choice?.source === "only_saved_key" ? undefined : choice
  } catch {
    return undefined // several keys, none chosen: nothing asked for yet
  }
}
