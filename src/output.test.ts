import { describe, expect, it } from "vitest"

import { count } from "./output.ts"

describe("count", () => {
  it("names one thing in the singular, and none or several in the plural", () => {
    expect([0, 1, 2].map((n) => count(n, "record"))).toEqual([
      "0 records",
      "1 record",
      "2 records",
    ])
    expect(count(2, "entry", "entries")).toBe("2 entries")
  })
})
