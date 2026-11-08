import { describe, expect, it } from "vitest"

import { configurationChange, keptOptions } from "./field-types.ts"

describe("configurationChange", () => {
  it("sends the options that differ, and null for each one left out", () => {
    expect(
      configurationChange(
        { max_length: 80, filterable: true, description: "Shown in lists" },
        { max_length: 40, filterable: true, sortable: true }
      )
    ).toEqual({ max_length: 40, sortable: true, description: null })
  })

  it("treats empty and null options as absent, and compares lists by value", () => {
    expect(
      configurationChange(
        { options: ["a", "b"], description: "" },
        { options: ["a", "b"], description: null }
      )
    ).toEqual({})
    expect(
      configurationChange({ options: ["a", "b"] }, { options: ["b", "a"] })
    ).toEqual({ options: ["b", "a"] })
  })
})

describe("keptOptions", () => {
  it("keeps every option within a type, and only the shared ones across types", () => {
    const options = { max_length: 80, unique: true, filterable: true }
    expect(keptOptions(options, "text", "text")).toBe(options)
    expect(keptOptions(options, "text", "enum")).toEqual({ filterable: true })
  })
})
