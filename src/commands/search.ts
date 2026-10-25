import type { Command } from "commander"

import type { SearchIndex } from "@nohead/sdk"
import type { CommandContext } from "../context.ts"
import { unwrap } from "../errors.ts"
import { positiveInteger, usageError } from "../input.ts"
import { parseFilters } from "../filters.ts"
import { details, formatValue, printResult, table } from "../output.ts"
import { recordStatus } from "./records.ts"

function collect(value: string, previous: string[] = []) {
  return [...previous, value]
}

function describeIndex(index: SearchIndex): string {
  return details([
    ["status", index.status],
    ["index", index.index],
    ["records", String(index.documents)],
    ["built", index.last_built_at ?? "never"],
  ])
}

export function registerSearch(
  program: Command,
  context: () => CommandContext
) {
  program
    .command("search")
    .description(
      "Search records: in one collection with --collection, else across the project"
    )
    .argument("[query]", "words to search for", "")
    .option("--collection <c>", "search one collection (slug or ID)")
    .option(
      "--filter <expression>",
      'filter on a filterable field or "published_at exists", as in records list; repeatable',
      collect
    )
    .option(
      "--sort <sort>",
      "created_at, updated_at, published_at or a sortable field; - for descending"
    )
    .option("--limit <n>", "results (1-100)", "20")
    .action(
      async (
        query: string,
        options: {
          collection?: string
          filter?: string[]
          sort?: string
          limit: string
        }
      ) => {
        const ctx = context()
        const limit = positiveInteger(options.limit, "--limit")
        const filter = parseFilters(options.filter)
        let page
        if (options.collection) {
          page = await unwrap(
            ctx.api.records.search(options.collection, query, {
              filter,
              sort: options.sort,
              limit,
            })
          )
        } else {
          const { published_at: published, ...others } = filter
          if (
            options.sort ||
            Object.keys(others).length > 0 ||
            (published !== undefined &&
              (typeof published !== "object" ||
                Object.keys(published).some((op) => op !== "exists")))
          )
            throw usageError(
              'Across a project only --filter "published_at exists" (or !exists) works; pass --collection for more'
            )
          page = await unwrap(
            (await ctx.project()).search(query, {
              limit,
              filter:
                published?.exists === undefined
                  ? undefined
                  : { published_at: { exists: published.exists } },
            })
          )
        }
        printResult(ctx, page, () =>
          [
            table(
              ["ID", "COLLECTION", "STATUS", "RECORD"],
              page.data.map((record) => [
                record.id,
                record.collection,
                recordStatus(record),
                formatValue(
                  Object.values(record.data).find(
                    (v) => typeof v === "string"
                  ) ?? "",
                  50
                ),
              ])
            ),
            `\n${page.meta.total_estimate} match${page.meta.total_estimate === 1 ? "" : "es"}`,
          ].join("")
        )
      }
    )

  const collections = program.commands.find((c) => c.name() === "collections")
  if (!collections) throw new Error("register collections before search")
  collections
    .command("search-index")
    .description("Show a collection's search index status, or rebuild it")
    .argument("<collection>", "collection slug or ID")
    .option(
      "--rebuild",
      "rebuild the index from the collection's records",
      false
    )
    .action(async (collection: string, options: { rebuild: boolean }) => {
      const ctx = context()
      const index = await unwrap(
        options.rebuild
          ? ctx.api.collections.searchIndex.rebuild(
              collection,
              ctx.writeOptions()
            )
          : ctx.api.collections.searchIndex.get(collection)
      )
      printResult(ctx, index, () => describeIndex(index))
    })
}
