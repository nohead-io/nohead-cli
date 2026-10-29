import type { Command } from "commander"

import { browserLogin } from "../browser-login.ts"
import { configPath, readConfig, writeConfig } from "../config.ts"
import {
  createApi,
  DEFAULT_API_URL,
  envVar,
  profileName,
  requireSecureUrl,
  type CommandContext,
} from "../context.ts"
import { unwrap } from "../errors.ts"
import { usageError } from "../input.ts"
import { printNotice, printResult } from "../output.ts"

interface LoginFlags {
  withToken?: boolean
  browser: boolean
}

export function registerLogin(program: Command, context: () => CommandContext) {
  program
    .command("login")
    .description(
      "Sign in and save an API key: approve the CLI in the browser, or pipe a key in (echo $KEY | nohead login)"
    )
    .option(
      "--with-token",
      "paste an API key from the web app instead of signing in with the browser"
    )
    .option(
      "--no-browser",
      "print the sign-in page's URL instead of opening the browser"
    )
    .action(async (flags: LoginFlags) => {
      const ctx = context()
      const { runtime, options } = ctx
      const name = profileName(options, runtime.env)
      const apiUrl =
        options.apiUrl ??
        envVar(runtime.env, "NOHEAD_API_URL") ??
        DEFAULT_API_URL

      const { apiKey, key, project } =
        runtime.stdinIsTTY && !flags.withToken
          ? await signInWithBrowser(ctx, apiUrl, flags.browser)
          : await pastedKey(ctx, apiUrl)

      const config = await readConfig(runtime)
      config.profiles[name] = {
        api_url: apiUrl,
        api_key: apiKey,
        project_id: key.project_id,
      }
      const path = await writeConfig(runtime, config)
      const result = {
        profile: name,
        api_url: apiUrl,
        project_id: key.project_id,
        api_key: { id: key.id, name: key.name },
        config: path,
      }
      printResult(ctx, result, () =>
        [
          `Logged in to ${apiUrl} as ${key.name} (project ${project.name || project.id}).`,
          `Saved as profile "${name}" in ${path}.`,
        ].join("\n")
      )
      if (!options.json && envVar(runtime.env, "NOHEAD_API_KEY"))
        printNotice(
          ctx,
          "NOHEAD_API_KEY is set, so commands use it rather than this profile."
        )
    })

  program
    .command("logout")
    .description(
      "Forget a saved API key (the key itself stays valid; revoke it in the web app)"
    )
    .action(async () => {
      const ctx = context()
      const name = profileName(ctx.options, ctx.runtime.env)
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

interface SignedIn {
  apiKey: string
  key: { id: string; name: string; project_id: string }
  project: { id: string; name?: string }
}

/**
 * The browser flow: the person approves the CLI in the web app, which makes
 * an API key for the project they choose. The code and the page go to stderr
 * even with --json: without them, nobody can approve.
 */
async function signInWithBrowser(
  ctx: CommandContext,
  apiUrl: string,
  openBrowser: boolean
): Promise<SignedIn> {
  // The new key comes back in the answer.
  requireSecureUrl(apiUrl)
  const approved = await browserLogin({
    runtime: ctx.runtime,
    apiUrl,
    openBrowser,
    notify: (message) => printNotice(ctx, message),
  })
  return {
    apiKey: approved.token,
    key: approved.api_key,
    project: approved.project,
  }
}

/** A key pasted in, checked with the API before it is saved. */
async function pastedKey(
  ctx: CommandContext,
  apiUrl: string
): Promise<SignedIn> {
  const { runtime, options } = ctx
  // At a terminal (--with-token) the key is read without echo, so it never
  // stays on screen or in scrollback. Piped in (echo $KEY | nohead login),
  // as agents and CI do, it is read from stdin. With --json, stderr carries
  // only an error document, so there is no prompt.
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

  const api = createApi({ baseUrl: apiUrl, apiKey, fetch: runtime.fetch })
  const me = await unwrap(api.me.get())
  if (!me.api_key)
    throw usageError(
      "That is not a project API key; log in with one from the web app (API keys)"
    )
  return {
    apiKey,
    key: me.api_key,
    project: { id: me.api_key.project_id },
  }
}
