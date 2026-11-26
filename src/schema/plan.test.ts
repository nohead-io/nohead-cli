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
  const fields = (yaml: string) =>
    `collections:\n  posts:\n    fields:\n${yaml}\n`

  // Pulled, then planned against the same project: nothing to change.
  it.each([
    {
      what: "the project's schema, with relations by slug and default names left out",
      collections: remote,
      has: "author:\n        type: relation\n        collection: authors",
      lacks: "name: Title",
    },
    {
      what: "a collection in public search",
      collections: [authors, { ...posts, public_search: true }],
      has: "posts:\n    public_search: true",
      lacks: "authors:\n    public_search",
    },
    {
      what: "an asset field's accepted file types",
      collections: [
        collection({
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
        }),
      ],
      has: "accepted_types",
    },
    {
      what: "a unique slug, its uniqueness implied",
      collections: [
        collection({
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
        }),
      ],
      has: "format: slug",
      lacks: "unique",
    },
    {
      what: "a field's search settings, grouped in the file's order",
      collections: [
        collection({
          fields: [
            field({
              key: "title",
              name: "Title",
              configuration: {
                search: { returned: false, sortable: true, filterable: true },
              },
            }),
          ],
        }),
      ],
      has: "search:\n          filterable: true\n          sortable: true\n          returned: false",
    },
    {
      // The API keeps them as Postgres jsonb does: shortest key first.
      what: "a field's options in the file's order, not the API's",
      collections: [
        collection({
          fields: [
            field({
              key: "lat",
              name: "Lat",
              type: "decimal",
              configuration: { max: 90, min: -90, description: "Latitude." },
            }),
          ],
        }),
      ],
      has: "description: Latitude.\n        min: -90\n        max: 90",
    },
    {
      what: "search settings that are the default, left out",
      collections: [
        collection({
          fields: [
            field({
              key: "title",
              name: "Title",
              configuration: { search: { returned: true } },
            }),
          ],
        }),
      ],
      has: "type: text",
      lacks: "search",
    },
  ])("round-trips $what", ({ collections, has, lacks }) => {
    const yaml = toYaml(fromCollections(collections))

    expect(yaml).toContain(has)
    if (lacks) expect(yaml).not.toContain(lacks)
    expect(
      planChanges(
        fromYaml(yaml, "schema.yaml"),
        fromCollections(collections),
        collections
      )
    ).toEqual([])
  })

  it.each([
    {
      problem: "an unknown type",
      yaml: fields("      title: { type: txt }"),
      error: 's.yaml: collections.posts.fields.title: unknown type "txt"',
    },
    {
      problem: "a misspelt key",
      yaml: "collections:\n  posts:\n    feilds: {}",
      error: "collections.posts: unknown key feilds",
    },
    {
      problem: "an option no format has",
      yaml: fields(
        "      slug: { type: text, format: slug, source_field: title }"
      ),
      error: "collections.posts.fields.slug: unknown key source_field",
    },
    {
      problem: "the old search setting",
      yaml: "collections:\n  posts:\n    search: true\n    fields:\n      title: text\n",
      error: "collections.posts.search: no longer a setting",
    },
    {
      problem: "a public_search that is not true or false",
      yaml: "collections:\n  posts:\n    public_search: yes please\n    fields:\n      title: text\n",
      error: "collections.posts.public_search must be true or false",
    },
    {
      problem: "a relation without its collection",
      yaml: fields("      a: { type: relation }"),
      error: 'relation fields need "collection"',
    },
    {
      problem: "a rename from a key still in the file",
      yaml: fields(
        "      title: text\n      headline: { type: text, renamed_from: title }"
      ),
      error: "renamed_from title, but title is also in the file",
    },
    {
      problem: "a rename from a name, not a key",
      yaml: fields("      a: { type: text, renamed_from: Old }"),
      error: "renamed_from is the field's previous API key",
    },
    {
      problem: "an old search option at the top",
      yaml: fields("      title: { type: text, filterable: true }"),
      error:
        "title: filterable goes under search: (search: { filterable: true })",
    },
    {
      problem: "the old included",
      yaml: fields("      title: { type: text, included: false }"),
      error:
        "title: included goes under search: as returned (search: { returned: false })",
    },
    {
      problem: "the old searched",
      yaml: fields(
        "      author: { type: relation, collection: authors, searchable: true, searched: [name, bio] }"
      ),
      error:
        "author: searched goes under search: as searchable (search: { searchable: [name, bio] })",
    },
    {
      problem: "a search group that is not a mapping",
      yaml: fields("      title: { type: text, search: true }"),
      error: "title.search must be a mapping",
    },
    {
      problem: "an unknown search setting",
      yaml: fields("      title: { type: text, search: { expanded: [a] } }"),
      error: "title.search: unknown key expanded",
    },
    {
      problem: "a filterable that is not true or false",
      yaml: fields("      title: { type: text, search: { filterable: yes } }"),
      error: "title.search.filterable: true or false",
    },
    {
      problem: "a list on a text field",
      yaml: fields("      title: { type: text, search: { returned: [a] } }"),
      error: "title.search.returned: true or false",
    },
    {
      problem: "a searchable relation with no related fields",
      yaml: fields(
        "      author: { type: relation, collection: authors, search: { searchable: true } }"
      ),
      error:
        "author.search.searchable: a relation holds IDs, no words: list the related collection's field keys",
    },
    {
      problem: "a searchable asset",
      yaml: fields(
        "      cover: { type: asset, search: { searchable: true } }"
      ),
      error: "cover.search.searchable: asset fields hold no words to search",
    },
    {
      problem: "an asset's returned that is not a list of parts",
      yaml: fields("      cover: { type: asset, search: { returned: alt } }"),
      error: "cover.search.returned: true, false or a list (image_url,",
    },
  ])("refuses $problem", ({ yaml, error }) => {
    expect(() => fromYaml(yaml, "s.yaml")).toThrow(error)
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
      "+ collection testimonials (1 field)",
    ])
  })

  it("changes only the options that differ, and removes the ones the file leaves out", () => {
    const limited = collection({
      slug: "posts",
      fields: [
        field({
          key: "title",
          name: "Title",
          configuration: {
            max_length: 120,
            search: { filterable: true, returned: false },
          },
        }),
      ],
    })
    expect(
      planChanges(
        fromYaml(
          "collections:\n  posts:\n    fields:\n      title: { type: text, required: false, search: { filterable: true, sortable: true } }\n",
          "schema.yaml"
        ),
        fromCollections([limited]),
        [limited]
      ).map(describeChange)
    ).toEqual([
      '~ field posts.title: options {"search":{"sortable":true,"returned":null},"max_length":null}',
    ])
  })

  it("includes collections in public search, and takes them out", () => {
    const public_ = [authors, { ...posts, public_search: true }]

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
      // Only the option that changes: the time was already on.
      '~ field events.starts: options {"time_zone":"Europe/Copenhagen"}',
    ])
  })
})

describe("slugs in schema files", () => {
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
})

describe("search in schema files", () => {
  // The file's search group against the field's: only real changes, the
  // group merged one level down as the API does.
  it.each<{ file: string; have?: Record<string, unknown>; plan: string[] }>([
    {
      file: "search: { filterable: true }",
      plan: ['~ field posts.title: options {"search":{"filterable":true}}'],
    },
    { file: "search: { returned: true }", plan: [] },
    { file: "search: {}", plan: [] },
    {
      file: "search: { sortable: true, filterable: true }",
      have: { filterable: true, sortable: true },
      plan: [],
    },
    {
      file: "max_length: 10",
      have: { filterable: true },
      plan: ['~ field posts.title: options {"max_length":10,"search":null}'],
    },
  ])("plans $file against $have", ({ file, have, plan }) => {
    const remote = [
      collection({
        fields: [
          field({
            key: "title",
            name: "Title",
            configuration: have ? { search: have } : {},
          }),
        ],
      }),
    ]
    const changes = planChanges(
      fromYaml(
        `collections:\n  posts:\n    fields:\n      title: { type: text, ${file} }\n`,
        "s.yaml"
      ),
      fromCollections(remote),
      remote
    )

    expect(changes.map(describeChange)).toEqual(plan)
  })
})
