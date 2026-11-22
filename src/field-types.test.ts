import { describe, expect, it } from "vitest"

import { configurationChange } from "./field-types.ts"

describe("configurationChange", () => {
  it.each<{
    name: string
    current: Record<string, unknown>
    next: Record<string, unknown>
    change: Record<string, unknown>
  }>([
    {
      name: "sends the options that differ, and null for each one left out",
      current: { max_length: 80, unique: true, description: "Shown in lists" },
      next: { max_length: 40, unique: true, min_length: 2 },
      change: { max_length: 40, min_length: 2, description: null },
    },
    {
      name: "treats empty and null options as absent",
      current: { options: ["a", "b"], description: "", search: {} },
      next: { options: ["a", "b"], description: null },
      change: {},
    },
    {
      name: "compares lists by value",
      current: { options: ["a", "b"] },
      next: { options: ["b", "a"] },
      change: { options: ["b", "a"] },
    },
    {
      name: "merges the search group one level down",
      current: { search: { filterable: true, returned: false } },
      next: { search: { filterable: true, sortable: true } },
      change: { search: { sortable: true, returned: null } },
    },
    {
      name: "sends a new search group whole",
      current: {},
      next: { search: { searchable: ["fld_1"], returned: false } },
      change: { search: { searchable: ["fld_1"], returned: false } },
    },
    {
      name: "removes a search group left out",
      current: { search: { filterable: true } },
      next: {},
      change: { search: null },
    },
    {
      name: "leaves out a search group that doesn't change",
      current: { max_length: 80, search: { returned: ["fld_1"] } },
      next: { max_length: 40, search: { returned: ["fld_1"] } },
      change: { max_length: 40 },
    },
  ])("$name", ({ current, next, change }) => {
    expect(configurationChange(current, next)).toEqual(change)
  })
})
