import type { Command } from "commander"

import type { CommandContext } from "../context.ts"
import { unwrap } from "../errors.ts"
import { printResult, table } from "../output.ts"

export function registerFlags(program: Command, context: () => CommandContext) {
  program
    .command("flags")
    .description("Show feature flags as evaluated for your API key's project")
    .action(async () => {
      const ctx = context()
      const result = await unwrap(ctx.api.featureFlags.list())
      printResult(ctx, result, () =>
        table(
          ["FLAG", "ENABLED"],
          Object.entries(result.flags).map(([name, enabled]) => [
            name,
            enabled ? "yes" : "no",
          ])
        )
      )
    })
}
