// Writes commands.json: every command with its arguments and options, as
// the CLI defines them. The docs build their CLI reference from it (fetched
// from main, as they fetch the SDKs' samples.json), so the reference can't
// drift from the code. A test fails while it is stale: run `npm run commands`.
import { writeFileSync } from "node:fs"

import { describeCommands } from "../src/cli.ts"

writeFileSync(
  new URL("../commands.json", import.meta.url),
  JSON.stringify(describeCommands(), null, 2) + "\n"
)
