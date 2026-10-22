import type { Command } from "commander"

import type { Collection } from "@nohead/sdk"
import type { CommandContext } from "../context.ts"
import { unwrap } from "../errors.ts"
import { usageError } from "../input.ts"
import { details, printResult, table } from "../output.ts"

function summary(collection: Collection): string {
  return [
    details([
      ["id", collection.id],
      ["slug", collection.slug],
      ["name", collection.name],
      ["description", collection.description],
      ["schema version", collection.schema_version],
      ["deleted at", collection.deleted_at],
    ]),
    "",
    table(
      ["API KEY", "NAME", "TYPE", "RULES"],
      collection.fields.map((f) => [
        f.key,
        f.name,
        f.type,
        [f.required && "required", f.multiple && "multiple"]
          .filter(Boolean)
          .join(", "),
      ])
    ),
  ].join("\n")
}

export function registerCollections(
  program: Command,
  context: () => CommandContext
) {
  const collections = program
    .command("collections")
    .description("Manage collections (data models)")

  collections
    .command("list")
    .description("List collections in the project")
    .option("--deleted", "list deleted collections instead", false)
    .action(async (options: { deleted: boolean }) => {
      const ctx = context()
      const page = await unwrap(
        (await ctx.project()).collections.list({
          limit: 100,
          deleted: options.deleted,
        })
      )
      printResult(ctx, page, () =>
        table(
          ["SLUG", "NAME", "FIELDS", "SCHEMA", "ID"],
          page.data.map((c) => [
            c.slug,
            c.name,
            String(c.fields.length),
            `v${c.schema_version}`,
            c.id,
          ])
        )
      )
    })

  collections
    .command("get")
    .description("Show a collection and its fields")
    .argument("<collection>", "collection slug or ID")
    .action(async (collection: string) => {
      const ctx = context()
      const result = await unwrap(ctx.api.collections.get(collection))
      printResult(ctx, result, () => summary(result))
    })

  collections
    .command("create")
    .description("Create a collection")
    .argument("<slug>", "collection slug, e.g. posts")
    .option("--name <name>", "display name (default: from the slug)")
    .option("--description <text>", "description")
    .option(
      "--public-search",
      "include its published records in public search (search tokens)"
    )
    .action(
      async (
        slug: string,
        options: { name?: string; description?: string; publicSearch?: true }
      ) => {
        const ctx = context()
        const name =
          options.name ??
          slug.replace(/[-_]+/g, " ").replace(/^\w/, (c) => c.toUpperCase())
        const result = await unwrap(
          (await ctx.project()).collections.create(
            {
              slug,
              name,
              description: options.description,
              public_search: options.publicSearch,
            },
            ctx.writeOptions()
          )
        )
        printResult(
          ctx,
          result,
          () => `Created collection ${result.slug} (${result.id})`
        )
      }
    )

  collections
    .command("update")
    .description(
      "Update a collection's name, slug, description or public search"
    )
    .argument("<collection>", "collection slug or ID")
    .option("--name <name>", "new display name")
    .option("--slug <slug>", "new slug (breaks clients that use the old one)")
    .option("--description <text>", "new description")
    .option(
      "--public-search",
      "include its published records in public search (search tokens)"
    )
    .option("--no-public-search", "remove it from public search")
    .action(
      async (
        collection: string,
        options: {
          name?: string
          slug?: string
          description?: string
          publicSearch?: boolean
        }
      ) => {
        const ctx = context()
        const { publicSearch, ...rest } = options
        const body = { ...rest, public_search: publicSearch }
        if (Object.values(body).every((value) => value === undefined)) {
          throw usageError(
            "Nothing to update: pass --name, --slug, --description or --[no-]public-search"
          )
        }
        const result = await unwrap(
          ctx.api.collections.update(collection, body, ctx.writeOptions())
        )
        printResult(
          ctx,
          result,
          () =>
            `Updated collection ${result.slug} (schema v${result.schema_version})`
        )
      }
    )

  collections
    .command("delete")
    .description("Delete a collection (recoverable with restore)")
    .argument("<collection>", "collection slug or ID")
    .option("--yes", "confirm the deletion", false)
    .action(async (collection: string, options: { yes: boolean }) => {
      const ctx = context()
      if (!options.yes)
        throw usageError(`Refusing to delete ${collection} without --yes`)
      const result = await unwrap(
        ctx.api.collections.delete(collection, ctx.writeOptions())
      )
      printResult(
        ctx,
        result,
        () =>
          `Deleted collection ${result.slug}. Restore it with: nohead collections restore ${result.id}`
      )
    })

  collections
    .command("restore")
    .description("Restore a deleted collection")
    .argument("<collection>", "collection slug or ID")
    .action(async (collection: string) => {
      const ctx = context()
      const result = await unwrap(
        ctx.api.collections.restore(collection, ctx.writeOptions())
      )
      printResult(ctx, result, () => `Restored collection ${result.slug}`)
    })

  collections
    .command("history")
    .description("Show the collection's schema history, newest first")
    .argument("<collection>", "collection slug or ID")
    .action(async (collection: string) => {
      const ctx = context()
      const page = await unwrap(
        ctx.api.collections.schemaChanges.list(collection, { limit: 100 })
      )
      printResult(ctx, page, () =>
        table(
          ["VERSION", "OPERATION", "ACTOR", "VIA", "WHEN", "NOTE"],
          page.data.map((c) => [
            `v${c.to_version}`,
            c.operation + (c.payload.breaking === true ? " (breaking)" : ""),
            c.actor.name ?? c.actor.type,
            c.via,
            c.created_at,
            c.note ?? "",
          ])
        )
      )
    })
}
