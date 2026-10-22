import type { PagePromise } from "@nohead/sdk"

import type { CommandContext } from "./context.ts"
import { unwrap, unwrapAll } from "./errors.ts"
import { printResult } from "./output.ts"

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
