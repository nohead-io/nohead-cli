#!/usr/bin/env node
import { run } from "./cli.ts"
import { nodeRuntime } from "./node-runtime.ts"

process.exitCode = await run(process.argv.slice(2), nodeRuntime())
