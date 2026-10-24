import type {
  Collection,
  Field,
  NoheadDraft,
  NoheadRecord as RecordModel,
  RecordRevision,
} from "@nohead/sdk"

export const NOW = "2026-09-27T12:00:00.000Z"
export const PROJECT_ID = "prj_01J9ZQ3F8X5W2K7M4N6P0R1S2T"
export const COLLECTION_ID = "col_01J9ZQ3F8X5W2K7M4N6P0R1S2T"

export function field(overrides: Partial<Field> & Pick<Field, "key">): Field {
  return {
    id: `fld_01J9ZQ3F8X5W2K7M4N6P0${overrides.key.slice(0, 5).toUpperCase().padEnd(5, "0")}`,
    object: "field",
    collection_id: COLLECTION_ID,
    name: overrides.key,
    type: "text",
    required: false,
    multiple: false,
    position: 0,
    configuration: {},
    deleted_at: null,
    purge_after: null,
    aliases: [],
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  } as Field // a field of any type, configured by the test
}

export function collection(overrides: Partial<Collection> = {}): Collection {
  return {
    id: COLLECTION_ID,
    object: "collection",
    project_id: PROJECT_ID,
    name: "Posts",
    slug: "posts",
    description: null,
    schema_version: 2,
    deleted_at: null,
    purge_after: null,
    public_search: false,
    fields: [field({ key: "title", required: true })],
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  }
}

export function record(
  id: string,
  data: RecordModel["data"],
  overrides: Partial<RecordModel> = {}
): RecordModel {
  return {
    id,
    object: "record",
    collection_id: COLLECTION_ID,
    collection: "posts",
    published_at: null,
    revision: 1,
    schema_version: 2,
    deleted_at: null,
    purge_after: null,
    history_pruned_through: null,
    data,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  }
}

export const DRF_A = "drf_01J9ZQ3F8X5W2K7M4N6P0R1S2A"

export function draft(
  data: NoheadDraft["data"],
  overrides: Partial<NoheadDraft> = {}
): NoheadDraft {
  return {
    id: DRF_A,
    object: "draft",
    record_id: "rec_01J9ZQ3F8X5W2K7M4N6P0R1S2A",
    collection_id: COLLECTION_ID,
    collection: "posts",
    base_revision: 2,
    revision: 1,
    data,
    changed_fields: Object.keys(data),
    schedule: { merge_at: null, last_error: null },
    created_by: {
      type: "api_key",
      id: "key_01J9ZQ3F8X5W2K7M4N6P0R1S2T",
      name: "ci",
    },
    edited_by: [],
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  }
}

export function revision(
  number: number,
  overrides: Partial<RecordRevision> = {}
): RecordRevision {
  return {
    id: `rev_01J9ZQ3F8X5W2K7M4N6P0R1S2${number}`,
    object: "record_revision",
    record_id: "rec_01J9ZQ3F8X5W2K7M4N6P0R1S2T",
    revision: number,
    operation: number === 1 ? "create" : "update",
    actor: {
      type: "api_key",
      id: "key_01J9ZQ3F8X5W2K7M4N6P0R1S2T",
      name: "ci",
    },
    via: "cli",
    note: null,
    schema_version: 2,
    reverted_to_revision: null,
    changed_fields: ["title"],
    redacted_fields: [],
    draft: null,
    created_at: NOW,
    ...overrides,
  }
}

export function asset(status: "pending" | "ready" = "ready") {
  return {
    id: "ast_01J9ZQ3F8X5W2K7M4N6P0R1S2T",
    object: "asset" as const,
    project_id: PROJECT_ID,
    filename: "cover.png",
    alt: null,
    content_type: "image/png",
    byte_size: 3,
    width: status === "ready" ? 40 : null,
    height: status === "ready" ? 30 : null,
    status,
    deleted_at: null,
    purge_after: null,
    image_url: null,
    preview_url: null,
    file_url: status === "ready" ? "https://storage.test/original" : null,
    media_url: null,
    uploaded_at: status === "ready" ? NOW : null,
    created_at: NOW,
    updated_at: NOW,
  }
}

export const ME = {
  object: "principal" as const,
  type: "api_key" as const,
  user: null,
  api_key: {
    id: "key_01J9ZQ3F8X5W2K7M4N6P0R1S2T",
    name: "ci",
    scopes: ["records:read" as const],
    published_only: false,
    project_id: PROJECT_ID,
    expires_at: null,
  },
}

export const REC_A = "rec_01J9ZQ3F8X5W2K7M4N6P0R1S2A"
export const REC_B = "rec_01J9ZQ3F8X5W2K7M4N6P0R1S2B"
