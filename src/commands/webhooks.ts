import { Option, type Command } from "commander"

import type { Webhook, WebhookCreate, WebhookUpdate } from "@nohead/sdk"
import type { CommandContext } from "../context.ts"
import { unwrap } from "../errors.ts"
import { usageError } from "../input.ts"
import { details, printResult, table } from "../output.ts"
import { pageQuery, printList, withPaging, type PageOptions } from "../pages.ts"

export function registerWebhooks(
  program: Command,
  context: () => CommandContext
) {
  const webhooks = program
    .command("webhooks")
    .description("Send signed HTTP requests when content changes")

  withPaging(
    webhooks.command("list").description("List the project's webhooks"),
    "webhook"
  ).action(async (options: PageOptions) => {
    const ctx = context()
    const query = pageQuery(options)
    const api = await ctx.project()
    await printList(
      ctx,
      options.all,
      () => api.webhooks.list(query),
      (items) =>
        table(
          ["ID", "URL", "EVENTS", "STATUS"],
          items.map((w) => [w.id, w.url, events(w), status(w)])
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
    .option(
      "--published-only",
      "send only changes to published content: no drafts, schedules or edits to unpublished records"
    )
    .action(
      async (options: {
        url: string
        events: string
        description?: string
        publishedOnly?: boolean
      }) => {
        const ctx = context()
        const webhook = await unwrap(
          (await ctx.project()).webhooks.create(
            {
              url: options.url,
              description: options.description || null,
              event_types: eventTypes(options.events),
              published_only: options.publishedOnly ?? false,
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
    .command("get")
    .description("Show a webhook and how its deliveries are doing")
    .argument("<id>", "webhook ID (wh_...)")
    .action(async (id: string) => {
      const ctx = context()
      const webhook = await unwrap(ctx.api.webhooks.get(id))
      printResult(ctx, webhook, () => describe(webhook))
    })

  webhooks
    .command("update")
    .description(
      "Change a webhook, or turn it on again after Nohead disabled it"
    )
    .argument("<id>", "webhook ID (wh_...)")
    .addOption(
      new Option("--enable", "send it events again").conflicts("disable")
    )
    .option("--disable", "stop sending it events")
    .option("--url <url>", "https URL to send events to")
    .option("--events <types>", "comma-separated event types, or * for all")
    .option("--description <text>", 'what it is for ("" clears it)')
    .option(
      "--published-only",
      "send only changes to published content: no drafts, schedules or edits to unpublished records"
    )
    .option("--no-published-only", "send changes to all content")
    .action(
      async (
        id: string,
        options: {
          enable?: boolean
          disable?: boolean
          url?: string
          events?: string
          description?: string
          publishedOnly?: boolean
        }
      ) => {
        const ctx = context()
        const body: WebhookUpdate = {
          url: options.url,
          description:
            options.description === undefined
              ? undefined
              : options.description || null,
          event_types:
            options.events === undefined
              ? undefined
              : eventTypes(options.events),
          published_only: options.publishedOnly,
          enabled: options.enable ? true : options.disable ? false : undefined,
        }
        if (Object.values(body).every((value) => value === undefined))
          throw usageError(
            "Nothing to update: pass --enable, --disable, --url, --events, --description or --[no-]published-only"
          )
        const webhook = await unwrap(
          ctx.api.webhooks.update(id, body, ctx.writeOptions())
        )
        printResult(
          ctx,
          webhook,
          () => `Updated ${webhook.id} (${status(webhook)})`
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

  withPaging(
    webhooks
      .command("deliveries")
      .description("List a webhook's deliveries, newest first")
      .argument("<id>", "webhook ID (wh_...)")
      .addOption(
        new Option(
          "--status <status>",
          "only deliveries with this status"
        ).choices(["pending", "succeeded", "failed"])
      ),
    "delivery"
  ).action(
    async (
      id: string,
      options: PageOptions & { status?: "pending" | "succeeded" | "failed" }
    ) => {
      const ctx = context()
      const query = { ...pageQuery(options), status: options.status }
      await printList(
        ctx,
        options.all,
        () => ctx.api.webhooks.deliveries.list(id, query),
        (items) =>
          table(
            ["DELIVERY", "EVENT", "STATUS", "ATTEMPTS", "LAST"],
            items.map((d) => [
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

/**
 * "enabled", "failing" while its deliveries fail, "disabled", "disabled
 * (failing)" when Nohead disabled it after 3 days of failures, or "deleted".
 */
function status(webhook: Webhook): string {
  if (webhook.deleted_at) return "deleted"
  if (!webhook.enabled)
    return webhook.disabled_reason === "failing"
      ? "disabled (failing)"
      : "disabled"
  return webhook.failing_since ? "failing" : "enabled"
}

function eventTypes(list: string) {
  const types = list
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
  if (types.length === 0)
    throw usageError("--events needs an event type, or * for all")
  return types as WebhookCreate["event_types"]
}

function events(webhook: Webhook): string {
  return (
    webhook.event_types.join(",") +
    (webhook.published_only ? " (published only)" : "")
  )
}

/** The webhook with its last delivery attempt, once there has been one. */
function describe(webhook: Webhook): string {
  const entries: [string, unknown][] = [
    ["id", webhook.id],
    ["url", webhook.url],
  ]
  if (webhook.description) entries.push(["description", webhook.description])
  entries.push(["events", events(webhook)], ["status", status(webhook)])
  if (webhook.failing_since)
    entries.push(["failing since", webhook.failing_since])
  if (webhook.last_attempt_at) {
    const outcome = webhook.last_status_code ?? webhook.last_error
    entries.push(
      [
        "last attempt",
        webhook.last_attempt_at + (outcome ? ` (${outcome})` : ""),
      ],
      ["last success", webhook.last_succeeded_at ?? "never"]
    )
  }
  return details(entries)
}
