import type { Command } from "commander"

import { configPath, readConfig, writeConfig } from "../config.ts"
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
import { chooseProject } from "../project.ts"

export function registerLogin(program: Command, context: () => CommandContext) {
  program
    .command("login")
    .description(
      "Save an API key for its project, for later commands; reads the key from stdin (echo $KEY | nohead login)"
    )
    .action(async () => {
      const ctx = context()
      const { runtime, options } = ctx
      const apiUrl =
        options.apiUrl ??
        envVar(runtime.env, "NOHEAD_API_URL") ??
        DEFAULT_API_URL

      // At a terminal the key is read without echo, so it never stays on
      // screen or in scrollback. Piped in (echo $KEY | nohead
      // login), as agents and CI do, it is read as before. With --json,
      // stderr carries only an error document, so there is no prompt.
      const apiKey = (
        runtime.stdinIsTTY
          ? await runtime.readSecret(
              options.json
                ? ""
                : "Paste an API key (create one in the web app under API keys), then press Enter: "
            )
          : await runtime.readStdin()
      ).trim()
      if (!apiKey)
        throw usageError(
          runtime.stdinIsTTY ? "No API key given" : "No API key given on stdin"
        )
      requireSecureUrl(apiUrl)

      // Check the key before saving it.
      const api = createApi({ baseUrl: apiUrl, apiKey, fetch: runtime.fetch })
      const me = await unwrap(api.me.get())
      if (!me.api_key)
        throw usageError(
          "That is not a project API key; log in with one from the web app (API keys)"
        )

      const project = me.api_key.project_id
      const config = await readConfig(runtime)
      // One key per project: logging in again for it replaces the old one.
      const replaced = project in config.keys
      config.keys[project] = {
        api_url: apiUrl,
        api_key: apiKey,
        name: me.api_key.name,
      }
      const path = await writeConfig(runtime, config)
      const result = {
        api_url: apiUrl,
        project_id: project,
        api_key: { id: me.api_key.id, name: me.api_key.name },
        replaced,
        config: path,
      }
      printResult(ctx, result, () =>
        [
          `Logged in to ${apiUrl} with API key ${me.api_key!.name} (project ${project}).`,
          `${replaced ? "Replaced the saved key" : "Saved the key"} for project ${project} in ${path}.`,
        ].join("\n")
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
      const { runtime, options } = ctx
      const config = await readConfig(runtime)
      // The project a command would use its saved key for, whatever
      // NOHEAD_API_KEY says.
      const project = chooseProject({
        options,
        env: runtime.env,
        config,
        link: ctx.link,
        apiUrl: options.apiUrl ?? envVar(runtime.env, "NOHEAD_API_URL"),
      })?.project
      const key = project ? config.keys[project] : undefined
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
