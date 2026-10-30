import { join } from "node:path"

import type { Command } from "commander"

import { readConfig, savedKey } from "../config.ts"
import type { CommandContext } from "../context.ts"
import { parseOwnFile, usageError } from "../input.ts"
import { printNotice, printResult } from "../output.ts"
import { LINK_FILE } from "../project.ts"

export function registerLink(program: Command, context: () => CommandContext) {
  program
    .command("link")
    .description(
      `Use a project in this folder and the folders below it: writes ${LINK_FILE}, which holds no secret, so it can be committed`
    )
    .argument("<project>", "project ID (prj_...)")
    .action(async (project: string) => {
      const ctx = context()
      const { runtime, options } = ctx
      if (!project.startsWith("prj_"))
        throw usageError(`${project} is not a project ID (prj_...)`)

      // Other settings in an existing file stay as they are.
      const path = join(runtime.cwd(), LINK_FILE)
      let existing: Record<string, unknown> = {}
      try {
        existing = parseOwnFile(path, await runtime.readFile(path))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
      await runtime.writeFile(
        path,
        `${JSON.stringify({ ...existing, project }, null, 2)}\n`
      )

      // Linking comes first in a fresh checkout, so a missing key is only
      // a reminder here; commands that need it say so too.
      const saved = savedKey(await readConfig(runtime), project) !== undefined
      printResult(
        ctx,
        { project, link_file: path, saved_key: saved },
        () => `Linked ${path} to project ${project}.`
      )
      if (!saved && !options.json)
        printNotice(
          ctx,
          `No API key is saved for project ${project}: run \`nohead login\` here to sign in to it.`
        )
    })
}
