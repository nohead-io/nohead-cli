import type { Command } from "commander"

import type { CommandContext } from "../context.ts"
import { unwrap } from "../errors.ts"
import { printResult } from "../output.ts"

export function registerHealth(
  program: Command,
  context: () => CommandContext
) {
  program
    .command("health")
    .description("Check that the API is reachable and healthy")
    .action(async () => {
      const ctx = context()
      const health = await unwrap(ctx.publicApi.health.check())

      printResult(
        ctx,
        health,
        () => `API ${health.version} is ${health.status}`
      )
    })
}
