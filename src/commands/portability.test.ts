import { describe, expect, it } from "vitest"

import { record } from "../test/fixtures.ts"
import { publishesOnCreate, remapImages } from "./portability.ts"

describe("remapImages", () => {
  it("points images at the copies and leaves out those not copied", () => {
    const image = (id: string) => ({
      type: "image",
      attrs: { asset_id: id, alt: "" },
    })
    const paragraph = { type: "paragraph" }
    const copies = new Map([["ast_a", "ast_copy"]])

    expect(
      remapImages(
        { type: "doc", content: [image("ast_a"), paragraph, image("ast_b")] },
        (id) => copies.get(String(id))
      )
    ).toEqual({
      document: { type: "doc", content: [image("ast_copy"), paragraph] },
      dropped: 1,
    })
    expect(remapImages(null, () => undefined)).toEqual({
      document: null,
      dropped: 0,
    })
  })
})

describe("publishesOnCreate", () => {
  const kinds = { relations: ["author", "tags"], assets: [], richText: [] }
  const live = { published_at: "2026-10-01T00:00:00.000Z" }

  it("creates a live record published when it has no relations to set", () => {
    expect(
      publishesOnCreate(record("rec_1", { title: "Hi", tags: [] }, live), kinds)
    ).toBe(true)
    expect(
      publishesOnCreate(
        record("rec_1", { title: "Hi", author: null }, live),
        kinds
      )
    ).toBe(true)
  })

  it("leaves unpublished, deleted and related records to the later passes", () => {
    expect(publishesOnCreate(record("rec_1", { title: "Hi" }), kinds)).toBe(
      false
    )
    expect(
      publishesOnCreate(
        record(
          "rec_1",
          { title: "Hi" },
          { ...live, deleted_at: "2026-10-02T00:00:00.000Z" }
        ),
        kinds
      )
    ).toBe(false)
    expect(
      publishesOnCreate(record("rec_1", { author: "rec_2" }, live), kinds)
    ).toBe(false)
    expect(
      publishesOnCreate(record("rec_1", { tags: ["rec_2"] }, live), kinds)
    ).toBe(false)
  })
})
