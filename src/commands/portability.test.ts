import { describe, expect, it } from "vitest"

import { remapImages } from "./portability.ts"

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
