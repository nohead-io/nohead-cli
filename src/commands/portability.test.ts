import { describe, expect, it } from "vitest"

import { record } from "../test/fixtures.ts"
import type { CollectionSpec } from "../schema/format.ts"
import {
  creationOrder,
  publishesOnCreate,
  relationsAtCreate,
  remapImages,
} from "./portability.ts"

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
  const live = { published_at: "2026-10-01T00:00:00.000Z" }

  it("creates a live record published when no relations are left to set", () => {
    expect(
      publishesOnCreate(record("rec_1", { author: "rec_2" }, live), [])
    ).toBe(true)
  })

  it("leaves unpublished, deleted and still-to-link records to the later passes", () => {
    expect(publishesOnCreate(record("rec_1", { title: "Hi" }), [])).toBe(false)
    expect(
      publishesOnCreate(
        record(
          "rec_1",
          { title: "Hi" },
          { ...live, deleted_at: "2026-10-02T00:00:00.000Z" }
        ),
        []
      )
    ).toBe(false)
    expect(
      publishesOnCreate(record("rec_1", { author: "rec_2" }, live), ["author"])
    ).toBe(false)
  })
})

describe("creationOrder", () => {
  const collection = (slug: string, targets: string[]): CollectionSpec => ({
    slug,
    name: slug,
    description: null,
    public_search: false,
    fields: targets.map((target) => ({
      key: target,
      name: target,
      type: "relation",
      required: true,
      multiple: false,
      options: { collection: target },
    })),
  })

  it("puts relation targets first and keeps the export's order otherwise", () => {
    const schema = [
      collection("posts", ["people", "categories"]),
      collection("people", []),
      collection("pages", []),
      collection("categories", []),
    ]
    expect(
      creationOrder(["posts", "people", "pages", "categories"], schema)
    ).toEqual(["people", "categories", "posts", "pages"])
  })

  it("leaves self-references and cycles in the export's order", () => {
    const schema = [
      collection("pages", ["pages"]),
      collection("a", ["b"]),
      collection("b", ["a"]),
    ]
    expect(creationOrder(["pages", "a", "b"], schema)).toEqual([
      "pages",
      "b",
      "a",
    ])
  })
})

describe("relationsAtCreate", () => {
  const kinds = { relations: ["author", "tags"], assets: [], richText: [] }
  const exported = new Set(["rec_a", "rec_b", "rec_c"])

  it("sets relations whose targets exist now and leaves the rest for later", () => {
    const created = new Map([["rec_a", "rec_new_a"]])
    expect(
      relationsAtCreate(
        { title: "Hi", author: "rec_a", tags: ["rec_a", "rec_b"] },
        kinds,
        created,
        exported
      )
    ).toEqual({ now: { author: "rec_new_a" }, later: ["tags"] })
  })

  it("sets empty values now and leaves out targets that weren't exported", () => {
    expect(
      relationsAtCreate(
        { author: null, tags: ["rec_elsewhere"] },
        kinds,
        new Map(),
        exported
      )
    ).toEqual({ now: { author: null, tags: [] }, later: [] })
  })
})
