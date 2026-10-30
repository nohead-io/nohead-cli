import type { Command } from "commander"

import type { CommandContext } from "../context.ts"
import { unwrap } from "../errors.ts"
import { details, printResult } from "../output.ts"
import { describeSource } from "../project.ts"

export function registerWhoami(
  program: Command,
  context: () => CommandContext
) {
  program
    .command("whoami")
    .description(
      "Show the credentials in use (API key, project and where it came from, scopes)"
    )
    .action(async () => {
      const ctx = context()
      const me = await unwrap(ctx.api.me.get())
      // Defined once the API answered: the key was chosen through it.
      const choice = ctx.projectChoice()!
      const project = choice.project ?? me.api_key?.project_id
      // A folder's nohead.json that something else overrides is worth
      // saying: commands here don't use the project it links.
      const unusedLink =
        ctx.link && choice.source !== "nohead.json" ? ctx.link.path : undefined
      // A user's token has no project of its own.
      const source = project
        ? {
            project_id: project,
            project_source: choice.source,
            ...(choice.linkFile ? { link_file: choice.linkFile } : {}),
            ...(unusedLink ? { unused_link_file: unusedLink } : {}),
          }
        : {}
      const unused: [string, string][] = unusedLink
        ? [["not used", `${unusedLink} (${choice.source} wins)`]]
        : []
      printResult(ctx, { ...me, ...source }, () =>
        me.api_key
          ? details([
              ["api key", `${me.api_key.name} (${me.api_key.id})`],
              ["project", `${project} (from ${describeSource(choice)})`],
              ...unused,
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
              ...(project
                ? [
                    [
                      "project",
                      `${project} (from ${describeSource(choice)})`,
                    ] as [string, string],
                  ]
                : []),
            ])
      )
    })
}
