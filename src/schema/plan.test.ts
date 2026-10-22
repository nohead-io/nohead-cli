import fc from "fast-check"
import { describe, expect, it } from "vitest"

import { collection, field } from "../test/fixtures.ts"
import { fromCollections, fromYaml, toYaml } from "./format.ts"
import { applicable, type Change, describeChange, planChanges } from "./plan.ts"

const authors = collection({
  id: "col_01J9ZQ3F8X5W2K7M4N6P0AUTHR",
  slug: "authors",
  name: "Authors",
  fields: [field({ key: "name", name: "Name" })],
})
const posts = collection({
  slug: "posts",
  name: "Posts",
  fields: [
    field({ key: "title", name: "Title", required: true, position: 0 }),
    field({
      key: "author",
      name: "Author",
      type: "relation",
      position: 1,
      configuration: { target_collection_id: authors.id },
    }),
    field({ key: "price", name: "Price", position: 2 }),
  ],
})
const remote = [authors, posts]

const plan = (yaml: string) =>
  planChanges(fromYaml(yaml, "schema.yaml"), fromCollections(remote), remote)

describe("schema files", () => {
  it("round-trips the project's schema, with relations by slug and default names left out", () => {
    const yaml = toYaml(fromCollections(remote))

    expect(yaml).toContain(
      "author:\n        type: relation\n        collection: authors"
    )
    expect(yaml).not.toContain("name: Title")
    expect(applicable(plan(yaml))).toEqual([])
  })

  it("rejects unknown keys and types with the path to the problem", () => {
    expect(() =>
      fromYaml(
        "collections:\n  posts:\n    fields:\n      title: { type: txt }",
        "s.yaml"
      )
    ).toThrow('s.yaml: collections.posts.fields.title: unknown type "txt"')
    expect(() =>
      fromYaml("collections:\n  posts:\n    feilds: {}", "s.yaml")
    ).toThrow("unknown key feilds")
    expect(() =>
      fromYaml(
        "collections:\n  posts:\n    fields:\n      a: { type: relation }",
        "s.yaml"
      )
    ).toThrow('relation fields need "collection"')
    expect(() =>
      fromYaml(
        "collections:\n  posts:\n    fields:\n      title: text\n      headline: { type: text, renamed_from: title }",
        "s.yaml"
      )
    ).toThrow("renamed_from title, but title is also in the file")
    expect(() =>
      fromYaml(
        "collections:\n  posts:\n    fields:\n      a: { type: text, renamed_from: Old }",
        "s.yaml"
      )
    ).toThrow("renamed_from is the field's previous API key")
  })
})

describe("planChanges", () => {
  const base = `
collections:
  authors:
    fields:
      name: text
  posts:
    fields:
      title: { type: text, required: true }
      author: { type: relation, collection: authors }
      price: text
`

  it("plans additions, changes, migrations and never deletions", () => {
    const changes = plan(`
collections:
  authors:
    name: Writers
    fields:
      name: text
  posts:
    fields:
      title: { type: text, required: true, max_length: 120 }
      author: { type: relation, collection: authors }
      price: decimal
      summary: long_text
  testimonials:
    fields:
      quote: { type: long_text, required: true }
`)

    expect(changes.map(describeChange)).toEqual([
      '~ collection authors: name "Writers"',
      '~ field posts.title: options {"max_length":120}',
      "! field posts.price: text -> decimal (field migration)",
      "+ field posts.summary (long_text)",
      "+ collection testimonials (1 fields)",
    ])
  })

  it("includes collections in public search, and takes them out", () => {
    const public_ = [authors, { ...posts, public_search: true }]
    const yaml = toYaml(fromCollections(public_))
    expect(yaml).toContain("posts:\n    public_search: true")
    expect(yaml).not.toContain("authors:\n    public_search")
    expect(
      applicable(
        planChanges(
          fromYaml(yaml, "schema.yaml"),
          fromCollections(public_),
          public_
        )
      )
    ).toEqual([])

    // Left out means off: the file is the whole truth for a collection.
    expect(
      plan(
        base.replace("  authors:\n", "  authors:\n    public_search: true\n")
      ).map(describeChange)
    ).toEqual(["~ collection authors: public_search true"])
    expect(
      planChanges(
        fromYaml(base, "schema.yaml"),
        fromCollections(public_),
        public_
      ).map(describeChange)
    ).toContain("~ collection posts: public_search false")
    expect(() =>
      fromYaml(
        base.replace(
          "  authors:\n",
          "  authors:\n    public_search: yes please\n"
        ),
        "schema.yaml"
      )
    ).toThrow("collections.authors.public_search must be true or false")
  })

  it("reports what the file leaves out without touching it", () => {
    const changes = plan(`
collections:
  posts:
    fields:
      title: { type: text, required: true }
`)

    expect(applicable(changes)).toEqual([])
    expect(changes.map(describeChange)).toEqual([
      "· field posts.author is not in the file (left alone)",
      "· field posts.price is not in the file (left alone)",
      "· collection authors is not in the file (left alone)",
    ])
  })

  it("reorders fields only when their relative order changes", () => {
    expect(applicable(plan(base))).toEqual([])

    const reordered = plan(
      base
        .replace("      price: text\n", "")
        .replace(
          "posts:\n    fields:\n",
          "posts:\n    fields:\n      price: text\n"
        )
    )
    expect(reordered.map(describeChange)).toEqual([
      "~ collection posts: field order price, title, author",
    ])
    expect(reordered[0]).toMatchObject({ id: posts.id })
  })

  it("adds new fields last, then reorders when the file has them between others", () => {
    expect(
      plan(
        base.replace(
          "      price: text\n",
          "      price: text\n      summary: text\n"
        )
      ).map(describeChange)
    ).toEqual(["+ field posts.summary (text)"])
    expect(
      plan(
        base.replace(
          "      price: text\n",
          "      summary: text\n      price: text\n"
        )
      ).map(describeChange)
    ).toEqual([
      "+ field posts.summary (text)",
      "~ collection posts: field order title, author, summary, price",
    ])
  })

  it("keeps a field the file leaves out after the field it follows now", () => {
    const changes = plan(`
collections:
  posts:
    fields:
      title: { type: text, required: true }
      summary: text
      price: text
`).filter((c) => c.kind !== "unmanaged")

    // author stays after title: summary goes in after it.
    expect(changes.map(describeChange)).toEqual([
      "+ field posts.summary (text)",
      "~ collection posts: field order title, author, summary, price",
    ])
    const reordered = plan(`
collections:
  posts:
    fields:
      price: text
      title: { type: text, required: true }
      summary: text
`).filter((c) => c.kind !== "unmanaged")
    expect(reordered.map(describeChange)).toEqual([
      "+ field posts.summary (text)",
      "~ collection posts: field order price, title, author, summary",
    ])
  })

  it("reaches the file's order in one push, whatever the project's order", () => {
    const keys = ["a", "b", "c", "d", "e"]
    const posts = (order: string[]) =>
      collection({
        fields: order.map((key, position) => field({ key, position })),
      })
    const plan = (file: string[], order: string[]) =>
      planChanges(
        fromCollections([posts(file)]),
        fromCollections([posts(order)]),
        [posts(order)]
      )
    // The API adds a new field last; a reorder lists every field.
    const apply = (order: string[], changes: Change[]) =>
      changes.reduce((fields, change) => {
        if (change.kind === "add_field") return [...fields, change.field.key]
        if (change.kind === "reorder_fields") {
          expect(change.api_keys.toSorted()).toEqual(fields.toSorted())
          return change.api_keys
        }
        return fields
      }, order)

    fc.assert(
      fc.property(
        fc.shuffledSubarray(keys, { minLength: 1 }),
        fc.shuffledSubarray(keys),
        (file, order) => {
          const pushed = apply(order, plan(file, order))
          expect(applicable(plan(file, pushed))).toEqual([])
          expect(pushed.filter((key) => file.includes(key))).toEqual(file)
        }
      )
    )
  })

  it("renames a field from renamed_from, and ignores it once renamed", () => {
    const renamed = base.replace(
      "title: { type: text, required: true }",
      "headline: { type: text, required: true, renamed_from: title }"
    )
    const changes = plan(renamed)

    expect(changes.map(describeChange)).toEqual([
      '~ field posts.title -> headline (title stays an alias for 6 months): name "Headline"',
    ])
    expect(changes[0]).toMatchObject({
      field_id: posts.fields[0].id,
      changes: { key: "headline", name: "Headline" },
    })

    // After the push the project has headline, so the file plans nothing.
    const after = [
      authors,
      {
        ...posts,
        fields: posts.fields.map((f) =>
          f.key === "title" ? { ...f, key: "headline", name: "Headline" } : f
        ),
      },
    ]
    expect(
      planChanges(
        fromYaml(renamed, "schema.yaml"),
        fromCollections(after),
        after
      )
    ).toEqual([])
    expect(toYaml(fromCollections(after))).not.toContain("renamed_from")
  })

  it("renames before migrating when the type changes too", () => {
    const changes = plan(
      base.replace(
        "price: text",
        "cost: { type: decimal, renamed_from: price }"
      )
    )

    expect(changes.map(describeChange)).toEqual([
      "~ field posts.price -> cost (price stays an alias for 6 months)",
      "! field posts.cost: text -> decimal (field migration)",
    ])
  })
})

describe("date fields in schema files", () => {
  const events = collection({
    slug: "events",
    name: "Events",
    fields: [
      field({
        key: "starts",
        name: "Starts",
        type: "date",
        configuration: { include_time: true },
      }),
    ],
  })
  const planEvents = (yaml: string) =>
    planChanges(fromYaml(yaml, "schema.yaml"), fromCollections([events]), [
      events,
    ])

  it("migrates a date whose time is added or removed, and updates its time zone in place", () => {
    expect(
      applicable(
        planEvents("collections:\n  events:\n    fields:\n      starts: date\n")
      ).map(describeChange)
    ).toEqual([
      "! field events.starts: date with time -> date (field migration)",
    ])
    expect(
      applicable(
        planEvents(
          "collections:\n  events:\n    fields:\n      starts: { type: date, include_time: true, time_zone: Europe/Copenhagen }\n"
        )
      ).map(describeChange)
    ).toEqual([
      '~ field events.starts: options {"include_time":true,"time_zone":"Europe/Copenhagen"}',
    ])
  })
})

describe("asset fields in schema files", () => {
  it("round-trips the accepted file types and plans no change", () => {
    const media = collection({
      slug: "media",
      name: "Media",
      fields: [
        field({
          key: "cover",
          name: "Cover",
          type: "asset",
          configuration: { accepted_types: ["image/*", "application/pdf"] },
        }),
      ],
    })
    const yaml = toYaml(fromCollections([media]))
    expect(yaml).toContain("accepted_types")
    expect(
      applicable(
        planChanges(fromYaml(yaml, "schema.yaml"), fromCollections([media]), [
          media,
        ])
      )
    ).toEqual([])
  })
})

describe("slugs in schema files", () => {
  it("round-trips a unique slug and plans no change when it matches", () => {
    const articles = collection({
      slug: "articles",
      name: "Articles",
      fields: [
        field({ key: "title", name: "Title", position: 0 }),
        field({
          key: "slug",
          name: "Slug",
          position: 1,
          configuration: { format: "slug", unique: true },
        }),
      ],
    })
    const yaml = toYaml(fromCollections([articles]))
    expect(yaml).toContain("format: slug")
    // Implied by the slug.
    expect(yaml).not.toContain("unique")
    expect(
      applicable(
        planChanges(
          fromYaml(yaml, "schema.yaml"),
          fromCollections([articles]),
          [articles]
        )
      )
    ).toEqual([])
  })

  it("plans no change whether a file spells out a slug's unique or not", () => {
    const articles = collection({
      slug: "articles",
      name: "Articles",
      fields: [
        field({
          key: "slug",
          name: "Slug",
          configuration: { format: "slug", unique: true },
        }),
      ],
    })
    for (const spec of ["format: slug", "format: slug, unique: true"])
      expect(
        applicable(
          planChanges(
            fromYaml(
              `collections:\n  articles:\n    fields:\n      slug: { type: text, ${spec} }\n`,
              "schema.yaml"
            ),
            fromCollections([articles]),
            [articles]
          )
        )
      ).toEqual([])
  })

  it("refuses options formats don't have", () => {
    expect(() =>
      fromYaml(
        "collections:\n  a:\n    fields:\n      slug: { type: text, format: slug, source_field: title }\n",
        "schema.yaml"
      )
    ).toThrow(/source_field/)
  })
})

describe("search in schema files", () => {
  it("plans field search options", () => {
    const changes = planChanges(
      fromYaml(
        `collections:
  posts:
    fields:
      title: { type: text, required: true, filterable: true }
`,
        "s.yaml"
      ),
      fromCollections([
        collection({
          fields: [field({ key: "title", name: "Title", required: true })],
        }),
      ]),
      [
        collection({
          fields: [field({ key: "title", name: "Title", required: true })],
        }),
      ]
    )

    expect(changes.map(describeChange)).toEqual([
      '~ field posts.title: options {"filterable":true}',
    ])
  })

  it("says a collection's old search setting is gone", () => {
    expect(() =>
      fromYaml(
        "collections:\n  posts:\n    search: true\n    fields:\n      title: text\n",
        "s.yaml"
      )
    ).toThrow(/posts\.search: no longer a setting/)
  })

  it("writes search settings back", () => {
    const searched = [
      collection({
        fields: [
          field({
            key: "title",
            name: "Title",
            configuration: { sortable: true },
          }),
        ],
      }),
    ]
    const yaml = toYaml(fromCollections(searched))

    expect(yaml).toContain("sortable: true")
    expect(
      planChanges(fromYaml(yaml, "s.yaml"), fromCollections(searched), searched)
    ).toEqual([])
  })
})
