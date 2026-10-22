import fc from "fast-check"
import { describe, expect, it } from "vitest"

import { CliError, ExitCode } from "./errors.ts"
import { toFieldKey, parseJsonObject, parseSet, parseTime } from "./input.ts"

// Property-based tests: arguments come from anyone's shell.
// Whatever they are, parsing returns a value or a usage error (exit 2), never
// a crash. fast-check prints a shrunk counterexample and the seed on failure.
const fragment = fc.oneof(
  fc.constantFrom(
    "title",
    "=",
    ":=",
    ":",
    "3",
    "true",
    "null",
    "[1,2]",
    '{"a":1}',
    "{",
    '"',
    "\\",
    "==",
    "=:="
  ),
  fc.string()
)
const argument = fc
  .array(fragment, { maxLength: 6 })
  .map((parts) => parts.join(""))

function usageErrorOrValue(run: () => unknown) {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(CliError)
    expect((error as CliError).exitCode).toBe(ExitCode.Usage)
  }
}

describe("input parsing properties", () => {
  it("parses --set pairs or refuses them as usage errors", () => {
    fc.assert(
      fc.property(fc.array(argument, { minLength: 1, maxLength: 3 }), (pairs) =>
        usageErrorOrValue(() => parseSet(pairs))
      )
    )
  })

  it("keeps plain values as strings and := values as the JSON they spell", () => {
    fc.assert(
      fc.property(fc.string(), fc.jsonValue(), (text, json) => {
        expect(parseSet([`key=${text}`]).key).toBe(text)
        expect(parseSet([`key:=${JSON.stringify(json)}`]).key).toEqual(
          JSON.parse(JSON.stringify(json))
        )
      })
    )
  })

  it("reads schedule times or refuses them as usage errors", () => {
    const now = new Date("2026-09-27T12:00:00.000Z")
    fc.assert(
      fc.property(
        fc.oneof(
          argument,
          fc.string(),
          fc.date({ noInvalidDate: true }).map((d) => d.toISOString())
        ),
        (text) => usageErrorOrValue(() => parseTime(text, "--publish-at", now))
      )
    )
  })

  it("reads JSON objects or refuses them as usage errors", () => {
    fc.assert(
      fc.property(fc.oneof(argument, fc.json()), (text) =>
        usageErrorOrValue(() => parseJsonObject(text, "input"))
      )
    )
  })
})

describe("toFieldKey", () => {
  it("transliterates letters rather than drop them", () => {
    expect(toFieldKey("Crème brûlée")).toBe("creme_brulee")
    expect(toFieldKey("Größe")).toBe("groesse")
  })

  it("starts with a letter and fits 63 characters", () => {
    expect(toFieldKey("2024 Recap")).toBe("recap")
    expect(toFieldKey(`${"x".repeat(62)} y`)).toBe("x".repeat(62))
  })

  it("makes a valid key or nothing from any name", () => {
    fc.assert(
      fc.property(fc.string(), (name) => {
        expect(toFieldKey(name)).toMatch(/^([a-z][a-z0-9_]{0,62})?$/)
      })
    )
  })
})
