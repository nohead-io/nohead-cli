import { describe, expect, it } from "vitest"

import { contentTypeFor } from "./assets.ts"

describe("contentTypeFor", () => {
  it("falls back to bytes for unknown files", () => {
    expect(contentTypeFor("data.unknownext")).toBe("application/octet-stream")
    expect(contentTypeFor("Makefile")).toBe("application/octet-stream")
  })
})
