import type { Command } from "commander"

import { browserLogin } from "../browser-login.ts"
import { configPath, readConfig, writeConfig, type Profile } from "../config.ts"
import {
  createApi,
  DEFAULT_API_URL,
  envVar,
  isCliSession,
  profileName,
  requireSecureUrl,
  type CommandContext,
} from "../context.ts"
import { unwrap } from "../errors.ts"
import { usageError } from "../input.ts"
import { printNotice, printResult } from "../output.ts"
import { send } from "../web-api.ts"

interface LoginFlags {
  withToken?: boolean
  web?: boolean
  browser: boolean
}

export function registerLogin(program: Command, context: () => CommandContext) {
  program
    .command("login")
    .description(
      "Sign in with the browser, acting as you in your projects; or save an API key (echo $KEY | nohead login)"
    )
    .option(
      "--with-token",
      "paste an API key from the web app instead of signing in with the browser"
    )
    .option(
      "--web",
      "sign in with the browser even without a terminal (a coding agent shows you the code to approve)"
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

      if (flags.web || (runtime.stdinIsTTY && !flags.withToken)) {
        // The new session's token comes back in the answer.
        requireSecureUrl(apiUrl)
        const approved = await browserLogin({
          runtime,
          apiUrl,
          openBrowser: flags.browser,
          notify: (message) => printNotice(ctx, message),
        })
        const { user, session, project } = approved
        const path = await saveProfile(ctx, name, {
          api_url: apiUrl,
          token: approved.token,
          ...(project ? { project_id: project.id } : {}),
        })
        const result = {
          profile: name,
          api_url: apiUrl,
          user,
          session: {
            id: session.id,
            name: session.name,
            expires_at: session.expires_at,
          },
          project,
          config: path,
        }
        printResult(ctx, result, () =>
          [
            `Logged in to ${apiUrl} as ${user.email}.`,
            project
              ? `Default project: ${project.name} (${project.id}).`
              : "No default project yet: choose one with `nohead use <project>` (`nohead projects list` shows yours).",
            `Saved as profile "${name}" in ${path}.`,
          ].join("\n")
        )
      } else {
        const { apiKey, key } = await pastedKey(ctx, apiUrl)
        const path = await saveProfile(ctx, name, {
          api_url: apiUrl,
          token: apiKey,
          project_id: key.project_id,
        })
        const result = {
          profile: name,
          api_url: apiUrl,
          project_id: key.project_id,
          api_key: { id: key.id, name: key.name },
          config: path,
        }
        printResult(ctx, result, () =>
          [
            `Logged in to ${apiUrl} as ${key.name} (project ${key.project_id}).`,
            `Saved as profile "${name}" in ${path}.`,
          ].join("\n")
        )
      }
      if (!options.json && envVar(runtime.env, "NOHEAD_API_KEY"))
        printNotice(
          ctx,
          "NOHEAD_API_KEY is set, so commands use it rather than this profile."
        )
    })

  program
    .command("logout")
    .description(
      "Sign out: end the CLI session and forget the saved profile (a saved API key stays valid; revoke it in the web app)"
    )
    .action(async () => {
      const ctx = context()
      const { runtime } = ctx
      const name = profileName(ctx.options, runtime.env)
      const config = await readConfig(runtime)
      const profile = config.profiles[name]
      if (!profile) {
        printResult(
          ctx,
          { profile: name, removed: false },
          () => `No saved profile "${name}".`
        )
        return
      }

      // Ended on the API, so the token is no good even if a copy remains.
      // Best effort: the profile goes either way.
      const session = isCliSession(profile.token)
      const ended = session && (await endSession(ctx, profile))
      delete config.profiles[name]
      await writeConfig(runtime, config)
      printResult(
        ctx,
        {
          profile: name,
          removed: true,
          ...(session ? { session_ended: ended } : {}),
        },
        () => `Logged out of profile "${name}" (${configPath(runtime.env)}).`
      )
      if (session && !ended && !ctx.options.json)
        printNotice(
          ctx,
          "Could not end the CLI session on the API; it stays valid until it expires, or you end it on your Account page in the web app."
        )
    })
}

/** Saves a profile, keeping the others. */
async function saveProfile(
  ctx: CommandContext,
  name: string,
  profile: Profile
): Promise<string> {
  const config = await readConfig(ctx.runtime)
  config.profiles[name] = profile
  return writeConfig(ctx.runtime, config)
}

/** Ends a CLI session (DELETE /auth/cli-session); false if that failed. */
async function endSession(
  ctx: CommandContext,
  profile: Profile
): Promise<boolean> {
  try {
    requireSecureUrl(profile.api_url)
  } catch {
    return false
  }
  const answer = await send(
    ctx.runtime,
    profile.api_url,
    "DELETE",
    "/auth/cli-session",
    { token: profile.token }
  )
  return !("unreachable" in answer) && answer.status === 204
}

/** A key pasted in, checked with the API before it is saved. */
async function pastedKey(
  ctx: CommandContext,
  apiUrl: string
): Promise<{
  apiKey: string
  key: { id: string; name: string; project_id: string }
}> {
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
      runtime.stdinIsTTY
        ? "No API key given"
        : "No API key given on stdin. To sign in with the browser instead, run: nohead login --web"
    )
  requireSecureUrl(apiUrl)

  const api = createApi({ baseUrl: apiUrl, apiKey, fetch: runtime.fetch })
  const me = await unwrap(api.me.get())
  if (!me.api_key)
    throw usageError(
      "That is not a project API key; log in with one from the web app (API keys), or sign in with the browser (nohead login)"
    )
  return { apiKey, key: me.api_key }
}
