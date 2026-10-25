import type { Command } from "commander"

import type { PagePromise } from "@nohead/sdk"
import type { CommandContext } from "./context.ts"
import { unwrap, unwrapAll } from "./errors.ts"
import { positiveInteger } from "./input.ts"
import { printResult } from "./output.ts"

/** The options {@link withPaging} adds. */
export interface PageOptions {
  limit?: string
  cursor?: string
  all: boolean
}

/**
 * Adds a list command's paging options: `--limit` (the page size, 100 unless
 * the command gives another default), `--cursor` and `--all` (which follows
 * cursors and returns every one of `items`).
 */
export function withPaging(
  command: Command,
  items: string,
  defaultLimit?: number
): Command {
  return command
    .option(
      "--limit <n>",
      "page size (1-100)",
      defaultLimit === undefined ? undefined : String(defaultLimit)
    )
    .option("--cursor <cursor>", "continue from a previous page's next_cursor")
    .option("--all", `follow cursors and return every ${items}`, false)
}

/** The list query for the paging options: 100 to a page unless --limit. */
export function pageQuery(options: Omit<PageOptions, "all">): {
  limit: number
  cursor?: string
} {
  return {
    limit:
      options.limit === undefined
        ? 100
        : positiveInteger(options.limit, "--limit"),
    ...(options.cursor ? { cursor: options.cursor } : {}),
  }
}

/**
 * Prints a list command's result: with `all`, every page (as `{ data }`);
 * otherwise one page, and the cursor for the next when there is one.
 */
export async function printList<T>(
  ctx: CommandContext,
  all: boolean,
  list: () => PagePromise<T>,
  render: (items: T[]) => string
): Promise<void> {
  if (all) {
    const items = await unwrapAll(list())
    printResult(ctx, { data: items }, () => render(items))
    return
  }
  const page = await unwrap(list())
  printResult(
    ctx,
    page,
    () =>
      render(page.data) +
      (page.meta.has_more ? `\nMore: --cursor ${page.meta.next_cursor}` : "")
  )
}
