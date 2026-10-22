import type { Command } from "commander"

import {
  configPath,
  DEFAULT_PROFILE,
  readConfig,
  writeConfig,
} from "../config.ts"
import {
  createApi,
  DEFAULT_API_URL,
  requireSecureUrl,
  type CommandContext,
} from "../context.ts"
import { unwrap } from "../errors.ts"
import { usageError } from "../input.ts"
import { printResult } from "../output.ts"

export function registerLogin(program: Command, context: () => CommandContext) {
  program
    .command("login")
    .description(
      "Save an API key for later commands; reads the key from stdin (echo $KEY | nohead login)"
    )
    .action(async () => {
      const ctx = context()
      const { runtime, options } = ctx
      const name =
        options.profile ?? runtime.env.NOHEAD_PROFILE ?? DEFAULT_PROFILE
      const apiUrl =
        options.apiUrl ?? runtime.env.NOHEAD_API_URL ?? DEFAULT_API_URL

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

      const config = await readConfig(runtime)
      config.profiles[name] = {
        api_url: apiUrl,
        api_key: apiKey,
        project_id: me.api_key.project_id,
      }
      const path = await writeConfig(runtime, config)
      const result = {
        profile: name,
        api_url: apiUrl,
        project_id: me.api_key.project_id,
        api_key: { id: me.api_key.id, name: me.api_key.name },
        config: path,
      }
      printResult(ctx, result, () =>
        [
          `Logged in to ${apiUrl} with API key ${me.api_key!.name} (project ${me.api_key!.project_id}).`,
          `Saved as profile "${name}" in ${path}.`,
        ].join("\n")
      )
    })

  program
    .command("logout")
    .description(
      "Forget a saved API key (the key itself stays valid; revoke it in the web app)"
    )
    .action(async () => {
      const ctx = context()
      const name =
        ctx.options.profile ?? ctx.runtime.env.NOHEAD_PROFILE ?? DEFAULT_PROFILE
      const config = await readConfig(ctx.runtime)
      const known = name in config.profiles
      delete config.profiles[name]
      if (known) await writeConfig(ctx.runtime, config)
      printResult(ctx, { profile: name, removed: known }, () =>
        known
          ? `Logged out of profile "${name}" (${configPath(ctx.runtime.env)}).`
          : `No saved profile "${name}".`
      )
    })
}
