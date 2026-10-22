import type { Command } from "commander"

import type { WebhookCreate } from "@nohead/sdk"
import type { CommandContext } from "../context.ts"
import { unwrap } from "../errors.ts"
import { printResult, table } from "../output.ts"

export function registerWebhooks(
  program: Command,
  context: () => CommandContext
) {
  const webhooks = program
    .command("webhooks")
    .description("Send signed HTTP requests when content changes")

  webhooks
    .command("list")
    .description("List the project's webhooks")
    .action(async () => {
      const ctx = context()
      const page = await unwrap(
        (await ctx.project()).webhooks.list({ limit: 100 })
      )
      printResult(ctx, page, () =>
        table(
          ["ID", "URL", "EVENTS", "STATUS"],
          page.data.map((w) => [
            w.id,
            w.url,
            w.event_types.join(","),
            w.enabled ? "enabled" : "disabled",
          ])
        )
      )
    })

  webhooks
    .command("create")
    .description("Create a webhook; prints its signing secret (shown only now)")
    .requiredOption("--url <url>", "https URL to send events to")
    .option(
      "--events <types>",
      "comma-separated event types, or * for all",
      "*"
    )
    .option("--description <text>", "what it is for")
    .action(
      async (options: {
        url: string
        events: string
        description?: string
      }) => {
        const ctx = context()
        const webhook = await unwrap(
          (await ctx.project()).webhooks.create(
            {
              url: options.url,
              description: options.description ?? null,
              event_types: options.events
                .split(",")
                .map((t) => t.trim()) as WebhookCreate["event_types"],
            },
            ctx.writeOptions()
          )
        )
        printResult(
          ctx,
          webhook,
          () => `Created ${webhook.id}\nSigning secret: ${webhook.secret}`
        )
      }
    )

  webhooks
    .command("delete")
    .description("Delete a webhook")
    .argument("<id>", "webhook ID (wh_...)")
    .action(async (id: string) => {
      const ctx = context()
      const webhook = await unwrap(
        ctx.api.webhooks.delete(id, ctx.writeOptions())
      )
      printResult(ctx, webhook, () => `Deleted ${webhook.id}`)
    })

  webhooks
    .command("rotate-secret")
    .description(
      "Add a new signing secret; the old ones keep signing for 24 hours"
    )
    .argument("<id>", "webhook ID (wh_...)")
    .action(async (id: string) => {
      const ctx = context()
      const secret = await unwrap(
        ctx.api.webhooks.rotateSecret(id, ctx.writeOptions())
      )
      printResult(
        ctx,
        secret,
        () =>
          `Signing secret: ${secret.secret}\nThe old secret signs too for 24 hours, so switch the receiver within that time.`
      )
    })

  webhooks
    .command("test")
    .description("Send a webhook.test event")
    .argument("<id>", "webhook ID (wh_...)")
    .action(async (id: string) => {
      const ctx = context()
      const delivery = await unwrap(
        ctx.api.webhooks.test(id, ctx.writeOptions())
      )
      printResult(
        ctx,
        delivery,
        () =>
          `Queued ${delivery.id}; follow it with: nohead webhooks delivery ${delivery.id}`
      )
    })

  webhooks
    .command("deliveries")
    .description("List a webhook's deliveries, newest first")
    .argument("<id>", "webhook ID (wh_...)")
    .option("--status <status>", "pending, succeeded or failed")
    .action(
      async (
        id: string,
        options: { status?: "pending" | "succeeded" | "failed" }
      ) => {
        const ctx = context()
        const page = await unwrap(
          ctx.api.webhooks.deliveries.list(id, {
            limit: 100,
            status: options.status,
          })
        )
        printResult(ctx, page, () =>
          table(
            ["DELIVERY", "EVENT", "STATUS", "ATTEMPTS", "LAST"],
            page.data.map((d) => [
              d.id,
              d.event.type,
              d.status,
              String(d.attempts_count),
              String(d.last_status_code ?? d.last_error ?? ""),
            ])
          )
        )
      }
    )

  webhooks
    .command("delivery")
    .description("Show a delivery with its attempts")
    .argument("<delivery>", "delivery ID (whd_...)")
    .action(async (id: string) => {
      const ctx = context()
      const delivery = await unwrap(ctx.api.webhooks.deliveries.get(id))
      printResult(ctx, delivery, () =>
        [
          `${delivery.event.type} ${delivery.event.id}: ${delivery.status}`,
          ...delivery.attempts.map(
            (a) =>
              `  #${a.number} ${a.status_code ?? a.error} (${a.duration_ms} ms) ${a.created_at}`
          ),
        ].join("\n")
      )
    })

  webhooks
    .command("retry")
    .description("Attempt a delivery again now")
    .argument("<delivery>", "delivery ID (whd_...)")
    .action(async (id: string) => {
      const ctx = context()
      const delivery = await unwrap(
        ctx.api.webhooks.deliveries.retry(id, ctx.writeOptions())
      )
      printResult(ctx, delivery, () => `Retrying ${delivery.id}`)
    })
}
