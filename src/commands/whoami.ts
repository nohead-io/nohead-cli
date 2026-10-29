import type { Command } from "commander"

import type { CommandContext } from "../context.ts"
import { unwrap } from "../errors.ts"
import { details, printResult } from "../output.ts"

export function registerWhoami(
  program: Command,
  context: () => CommandContext
) {
  program
    .command("whoami")
    .description(
      "Show the credentials in use: you and your project (a CLI session), or an API key's project and scopes"
    )
    .action(async () => {
      const ctx = context()
      const me = await unwrap(ctx.accountApi.me.get())
      if (ctx.session) {
        const project = ctx.chosenProjectId ?? null
        printResult(
          ctx,
          { ...me, api_url: ctx.baseUrl, project_id: project },
          () =>
            details([
              ["user", me.user?.name ?? me.user?.email],
              ["email", me.user?.email],
              ["signed in", "CLI session (acts as you)"],
              ["api", ctx.baseUrl],
              ["project", project ?? "none (choose one: nohead use <project>)"],
              ["from", ctx.credentials],
            ])
        )
        return
      }
      printResult(ctx, me, () =>
        me.api_key
          ? details([
              ["api key", `${me.api_key.name} (${me.api_key.id})`],
              ["project", me.api_key.project_id],
              ["scopes", me.api_key.scopes.join(", ")],
              ...(me.api_key.published_only
                ? [["records", "published only"] as [string, string]]
                : []),
              ["expires", me.api_key.expires_at ?? "never"],
              ["from", ctx.credentials],
            ])
          : details([
              ["user", me.user?.name ?? me.user?.email],
              ["email", me.user?.email],
            ])
      )
    })
}
