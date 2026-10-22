import type { Collection } from "@nohead/sdk"
import type { FieldType } from "../field-types.ts"
import type { CollectionSpec, FieldSpec } from "./format.ts"

/**
 * The changes that turn the project's schema into the file's. Nothing is ever
 * deleted: collections and fields only in the project are reported as
 * `unmanaged`. Type and `multiple` changes are `migrate_field` (explicit field
 * migrations). New fields are added last; when that leaves the
 * fields out of the file's order, one `reorder_fields` puts them in it, each
 * field the file leaves out after the field it follows now.
 */
export type Change =
  | { kind: "create_collection"; collection: CollectionSpec }
  | {
      kind: "update_collection"
      slug: string
      id: string
      name?: string
      description?: string | null
      public_search?: boolean
    }
  | { kind: "add_field"; slug: string; field: FieldSpec }
  | {
      kind: "update_field"
      slug: string
      field_id: string
      key: string
      changes: {
        /** A rename: the old key stays an alias for a while. */
        key?: string
        name?: string
        required?: boolean
        options?: Record<string, unknown>
      }
      /** The field as the file describes it. */
      to: FieldSpec
    }
  | {
      kind: "migrate_field"
      slug: string
      field_id: string
      key: string
      from: { type: FieldType; multiple: boolean; include_time?: boolean }
      to: FieldSpec
    }
  | {
      kind: "reorder_fields"
      slug: string
      id: string
      /** Every field of the collection, by its API key after the push. */
      api_keys: string[]
    }
  | { kind: "unmanaged"; slug: string; key?: string }

const normalize = (options: Record<string, unknown>) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(options)
        .filter(([, v]) => v !== undefined && v !== null && v !== "")
        .sort(([a], [b]) => a.localeCompare(b))
    )
  )

export function planChanges(
  desired: CollectionSpec[],
  current: CollectionSpec[],
  remote: Collection[]
): Change[] {
  const changes: Change[] = []
  const bySlug = new Map(current.map((c) => [c.slug, c]))
  const remoteBySlug = new Map(remote.map((c) => [c.slug, c]))

  for (const wanted of desired) {
    const existing = bySlug.get(wanted.slug)
    const collection = remoteBySlug.get(wanted.slug)
    if (!existing || !collection) {
      changes.push({ kind: "create_collection", collection: wanted })
      continue
    }

    const collectionChanges: {
      name?: string
      description?: string | null
      public_search?: boolean
    } = {}
    if (wanted.name !== existing.name) collectionChanges.name = wanted.name
    if ((wanted.description ?? null) !== (existing.description ?? null))
      collectionChanges.description = wanted.description
    if (wanted.public_search !== existing.public_search)
      collectionChanges.public_search = wanted.public_search
    if (Object.keys(collectionChanges).length > 0)
      changes.push({
        kind: "update_collection",
        slug: wanted.slug,
        id: collection.id,
        ...collectionChanges,
      })

    const fields = new Map(existing.fields.map((f) => [f.key, f]))
    const ids = new Map(collection.fields.map((f) => [f.key, f.id]))
    // The project's key for each wanted field: its own, or the one it was
    // renamed from while the project still has that.
    const sourceKey = (field: FieldSpec) =>
      fields.has(field.key)
        ? field.key
        : field.renamed_from && fields.has(field.renamed_from)
          ? field.renamed_from
          : undefined
    // The order after the push: the file's, with each field it leaves out
    // after the field that comes before it now.
    const fileKey = new Map(
      wanted.fields.flatMap((field) => {
        const key = sourceKey(field)
        return key ? [[key, field.key] as const] : []
      })
    )
    const leading: string[] = []
    const following = new Map<string, string[]>()
    let previous: string | undefined
    for (const { key: key } of existing.fields) {
      const managedKey = fileKey.get(key)
      if (managedKey) previous = managedKey
      else if (previous)
        following.set(previous, [...(following.get(previous) ?? []), key])
      else leading.push(key)
    }
    const order = [
      ...leading,
      ...wanted.fields.flatMap((field) => [
        field.key,
        ...(following.get(field.key) ?? []),
      ]),
    ]
    // The order once new fields are added (last).
    const added = [
      ...existing.fields.map((f) => fileKey.get(f.key) ?? f.key),
      ...wanted.fields.filter((f) => !sourceKey(f)).map((f) => f.key),
    ]

    wanted.fields.forEach((field) => {
      const key = sourceKey(field)
      const have = key && fields.get(key)
      if (!key || !have) {
        changes.push({ kind: "add_field", slug: wanted.slug, field })
        return
      }
      const fieldId = ids.get(key)!
      const rename = key !== field.key ? { key: field.key } : {}
      // Adding or removing a date's time rewrites its values too.
      const timeChanges =
        field.type === "date" &&
        have.type === "date" &&
        (field.options.include_time === true) !==
          (have.options.include_time === true)
      if (
        field.type !== have.type ||
        field.multiple !== have.multiple ||
        timeChanges
      ) {
        // Rename first: migrations run last and address the new key.
        if (key !== field.key)
          changes.push({
            kind: "update_field",
            slug: wanted.slug,
            field_id: fieldId,
            key: key,
            changes: rename,
            to: field,
          })
        changes.push({
          kind: "migrate_field",
          slug: wanted.slug,
          field_id: fieldId,
          key: field.key,
          from: {
            type: have.type,
            multiple: have.multiple,
            include_time: have.options.include_time === true,
          },
          to: field,
        })
        return
      }
      const update: {
        key?: string
        name?: string
        required?: boolean
        options?: Record<string, unknown>
      } = { ...rename }
      if (field.name !== have.name) update.name = field.name
      if (field.required !== have.required) update.required = field.required
      if (normalize(field.options) !== normalize(have.options))
        update.options = field.options
      if (Object.keys(update).length > 0)
        changes.push({
          kind: "update_field",
          slug: wanted.slug,
          field_id: fieldId,
          key: key,
          changes: update,
          to: field,
        })
    })

    if (added.join() !== order.join())
      changes.push({
        kind: "reorder_fields",
        slug: wanted.slug,
        id: collection.id,
        api_keys: order,
      })

    const managed = new Set(wanted.fields.map(sourceKey))
    for (const have of existing.fields) {
      if (!managed.has(have.key))
        changes.push({
          kind: "unmanaged",
          slug: wanted.slug,
          key: have.key,
        })
    }
  }

  for (const have of current) {
    if (!desired.some((c) => c.slug === have.slug))
      changes.push({ kind: "unmanaged", slug: have.slug })
  }
  return changes
}

const show = (value: unknown) => JSON.stringify(value)

/** One line per change, prefixed + (add), ~ (change), ! (migration) or · (left alone). */
export function describeChange(change: Change): string {
  switch (change.kind) {
    case "create_collection":
      return `+ collection ${change.collection.slug} (${change.collection.fields.length} fields)`
    case "update_collection":
      return `~ collection ${change.slug}: ${[
        change.name !== undefined && `name ${show(change.name)}`,
        change.description !== undefined &&
          `description ${show(change.description)}`,
        change.public_search !== undefined &&
          `public_search ${show(change.public_search)}`,
      ]
        .filter(Boolean)
        .join(", ")}`
    case "add_field":
      return `+ field ${change.slug}.${change.field.key} (${change.field.type}${change.field.required ? ", required" : ""})`
    case "update_field": {
      const { key: renamedTo, ...rest } = change.changes
      const details = Object.entries(rest)
        .map(([key, value]) => `${key} ${show(value)}`)
        .join(", ")
      if (!renamedTo) return `~ field ${change.slug}.${change.key}: ${details}`
      return `~ field ${change.slug}.${change.key} -> ${renamedTo} (${change.key} stays an alias for 6 months)${details ? `: ${details}` : ""}`
    }
    case "migrate_field": {
      const time = (type: FieldType, includeTime: boolean) =>
        type === "date" && includeTime ? " with time" : ""
      return `! field ${change.slug}.${change.key}: ${change.from.type}${time(change.from.type, change.from.include_time === true)}${change.from.multiple ? "[]" : ""} -> ${change.to.type}${time(change.to.type, change.to.options.include_time === true)}${change.to.multiple ? "[]" : ""} (field migration)`
    }
    case "reorder_fields":
      return `~ collection ${change.slug}: field order ${change.api_keys.join(", ")}`
    case "unmanaged":
      return change.key
        ? `· field ${change.slug}.${change.key} is not in the file (left alone)`
        : `· collection ${change.slug} is not in the file (left alone)`
  }
}

export const applicable = (changes: Change[]) =>
  changes.filter((c) => c.kind !== "unmanaged")
