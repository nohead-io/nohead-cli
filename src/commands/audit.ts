import type { Command } from "commander"

import type { CommandContext } from "../context.ts"
import { table } from "../output.ts"
import { pageQuery, printList, withPaging, type PageOptions } from "../pages.ts"

export function registerAudit(program: Command, context: () => CommandContext) {
  withPaging(
    program
      .command("audit")
      .description(
        "Show who changed what in the project, newest first (needs audit:read)"
      )
      .option("--type <type>", "an event type, or a prefix like record.*")
      .option("--resource <id>", "one resource's events (rec_..., col_...)")
      .option("--actor <id>", "a user (usr_...) or API key (key_...)")
      .option("--since <time>", "only events at or after this ISO 8601 time")
      .option("--until <time>", "only events before this ISO 8601 time"),
    "event",
    20
  ).action(
    async (
      options: PageOptions & {
        type?: string
        resource?: string
        actor?: string
        since?: string
        until?: string
      }
    ) => {
      const ctx = context()
      const query = {
        ...pageQuery(options),
        filter: {
          type: options.type,
          resource_id: options.resource,
          actor_id: options.actor,
          ...(options.since || options.until
            ? { created_at: { gte: options.since, lt: options.until } }
            : {}),
        },
      }
      const api = await ctx.project()
      await printList(
        ctx,
        options.all,
        () => api.auditEvents.list(query),
        (items) =>
          table(
            ["TIME", "ACTOR", "VIA", "TYPE", "RESOURCE"],
            items.map((e) => [
              e.created_at,
              e.actor.name ?? e.actor.id ?? e.actor.type,
              e.via ?? "",
              e.type,
              e.resource.id,
            ])
          )
      )
    }
  )
}
