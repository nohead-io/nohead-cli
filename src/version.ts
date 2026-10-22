import { createRequire } from "node:module"

// The package's own version: package.json ships with it, one level above
// both src/ and dist/.
const pkg = createRequire(import.meta.url)("../package.json") as {
  version: string
}
export const VERSION = pkg.version
