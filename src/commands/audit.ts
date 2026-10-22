import type { Command } from "commander"

import type { CommandContext } from "../context.ts"
import { unwrap } from "../errors.ts"
import { printResult, table } from "../output.ts"

export function registerAudit(program: Command, context: () => CommandContext) {
  program
    .command("audit")
    .description(
      "Show who changed what in the project, newest first (needs audit:read)"
    )
    .option("--type <type>", "an event type, or a prefix like record.*")
    .option("--resource <id>", "one resource's events (rec_..., col_...)")
    .option("--actor <id>", "a user (usr_...) or API key (key_...)")
    .option("--since <time>", "only events at or after this ISO 8601 time")
    .option("--until <time>", "only events before this ISO 8601 time")
    .option("--limit <n>", "how many events (1-100)", "20")
    .action(
      async (options: {
        type?: string
        resource?: string
        actor?: string
        since?: string
        until?: string
        limit: string
      }) => {
        const ctx = context()
        const page = await unwrap(
          (await ctx.project()).auditEvents.list({
            limit: Number(options.limit),
            filter: {
              type: options.type,
              resource_id: options.resource,
              actor_id: options.actor,
              ...(options.since || options.until
                ? { created_at: { gte: options.since, lt: options.until } }
                : {}),
            },
          })
        )
        printResult(ctx, page, () =>
          table(
            ["TIME", "ACTOR", "VIA", "TYPE", "RESOURCE"],
            page.data.map((e) => [
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
