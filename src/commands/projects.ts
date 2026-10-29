import type { Command } from "commander"

import { readConfig, writeConfig } from "../config.ts"
import { envVar, profileName, type CommandContext } from "../context.ts"
import { CliError, ExitCode } from "../errors.ts"
import { usageError } from "../input.ts"
import { printNotice, printResult, table } from "../output.ts"
import { pageQuery, withPaging, type PageOptions } from "../pages.ts"
import { allProjects, projectPage, type Project } from "../web-api.ts"

/**
 * The token of a CLI session, whose projects are to choose from; an API key
 * has its own.
 */
function sessionToken(ctx: CommandContext, command: string): string {
  const token = ctx.token()
  if (ctx.session) return token
  throw usageError(
    `An API key belongs to one project, which it always works in. \`nohead ${command}\` is for signing in with the browser (nohead login), which reaches all your projects.`
  )
}

function render(projects: Project[], chosen: string | undefined): string {
  return table(
    ["", "ID", "NAME", "SLUG", "ORGANIZATION"],
    projects.map((project) => [
      project.id === chosen ? "*" : "",
      project.id,
      project.name,
      project.slug,
      project.organization_id,
    ])
  )
}

export function registerProjects(
  program: Command,
  context: () => CommandContext
) {
  const projects = program
    .command("projects")
    .description("The projects you can work in, signed in with the browser")

  withPaging(
    projects
      .command("list")
      .description(
        "List your projects; * marks the one commands use (nohead use)"
      ),
    "project"
  ).action(async (options: PageOptions) => {
    const ctx = context()
    const token = sessionToken(ctx, "projects list")
    const { runtime, baseUrl, chosenProjectId } = ctx
    if (options.all) {
      const items = await allProjects(runtime, baseUrl, token)
      printResult(ctx, { data: items }, () => render(items, chosenProjectId))
      return
    }
    const page = await projectPage(runtime, baseUrl, token, pageQuery(options))
    printResult(
      ctx,
      page,
      () =>
        render(page.data, chosenProjectId) +
        (page.meta.has_more && page.meta.next_cursor
          ? `\nMore: --cursor ${page.meta.next_cursor}`
          : "")
    )
  })

  program
    .command("use")
    .description(
      "Choose the project commands work in by default (signed in with the browser)"
    )
    .argument("<project>", "project ID or slug (nohead projects list)")
    .action(async (wanted: string) => {
      const ctx = context()
      const { runtime } = ctx
      const token = sessionToken(ctx, "use")
      if (envVar(runtime.env, "NOHEAD_API_KEY"))
        throw usageError(
          "NOHEAD_API_KEY is set, so commands don't use the profile: set NOHEAD_PROJECT, or pass --project, instead."
        )

      const all = await allProjects(runtime, ctx.baseUrl, token)
      const byId = all.find((project) => project.id === wanted)
      // A slug is unique within an organization, not across them.
      const matches = byId ? [byId] : all.filter((p) => p.slug === wanted)
      if (matches.length > 1)
        throw usageError(
          `More than one of your projects has the slug "${wanted}": use its ID (${matches.map((p) => `${p.id} in ${p.organization_id}`).join(", ")})`
        )
      const [project] = matches
      if (!project)
        throw new CliError(ExitCode.ApiError, {
          type: "not_found",
          message: `None of your projects has the ID or slug "${wanted}" (nohead projects list shows them)`,
        })

      const name = profileName(ctx.options, runtime.env)
      const config = await readConfig(runtime)
      // The session was checked above, so the profile is there.
      config.profiles[name] = {
        ...config.profiles[name],
        project_id: project.id,
      }
      await writeConfig(runtime, config)
      printResult(ctx, { profile: name, project }, () =>
        [
          `Default project: ${project.name} (${project.id}).`,
          `Saved in profile "${name}".`,
        ].join("\n")
      )
      const override =
        ctx.options.project !== undefined
          ? "--project"
          : envVar(runtime.env, "NOHEAD_PROJECT")
            ? "NOHEAD_PROJECT"
            : undefined
      if (override && !ctx.options.json)
        printNotice(
          ctx,
          `${override} is set, so commands use that project rather than this one.`
        )
    })
}
