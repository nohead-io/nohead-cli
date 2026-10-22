import { describe, expect, it } from "vitest"

import { parseFilters } from "./filters.ts"

describe("--filter expressions", () => {
  it("turns comparisons, lists and exists into the API's filters", () => {
    expect(
      parseFilters([
        "title=Hello = world",
        "price>=10",
        "price<50",
        "name!=Untitled",
        "category in shoes,hats\\, caps,back\\\\slash",
        "cover exists",
        "photo !exists",
        "released<=today",
      ])
    ).toEqual({
      title: "Hello = world",
      price: { gte: "10", lt: "50" },
      name: { ne: "Untitled" },
      category: { in: ["shoes", "hats, caps", "back\\slash"] },
      cover: { exists: true },
      photo: { exists: false },
      released: { lte: "today" },
    })
  })

  it("keeps an equal value next to operators on the same key", () => {
    expect(parseFilters(["doors=2026-10-09", "doors<now"])).toEqual({
      doors: { eq: "2026-10-09", lt: "now" },
    })
  })

  it("refuses what it cannot read, and an operator given twice", () => {
    expect(() => parseFilters(["price"])).toThrow(/--filter expects/)
    expect(() => parseFilters(["Price<5"])).toThrow(/--filter expects/)
    expect(() => parseFilters(["price<5", "price<6"])).toThrow(
      "--filter gives price lt twice"
    )
  })
})
