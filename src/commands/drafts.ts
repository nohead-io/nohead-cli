import type { Command } from "commander"

import type { NoheadDraft } from "@nohead/sdk"
import type { CommandContext } from "../context.ts"
import { unwrap } from "../errors.ts"
import {
  ifMatch,
  parseTime,
  positiveInteger,
  readData,
  usageError,
} from "../input.ts"
import { details, printResult, table } from "../output.ts"
import { pageQuery, printList, withPaging, type PageOptions } from "../pages.ts"
import { withDataFlags, type DataOptions } from "./records.ts"

const IF_REVISION = [
  "--if-revision <n>",
  "fail with 412 unless the draft is still at this revision",
] as const

function draftTable(drafts: NoheadDraft[]): string {
  return table(
    ["ID", "RECORD", "REV", "CHANGES", "MERGES AT", "UPDATED"],
    drafts.map((d) => [
      d.id,
      d.record_id,
      String(d.revision),
      d.changed_fields.join(", "),
      d.schedule.merge_at ?? "",
      d.updated_at,
    ])
  )
}

function draftDetails(draft: NoheadDraft): string {
  const optional = (label: string, value: unknown): [string, unknown][] =>
    value ? [[label, value]] : []
  return details([
    ["id", draft.id],
    ["record", draft.record_id],
    ["revision", draft.revision],
    ["base revision", draft.base_revision],
    ["changes", draft.changed_fields.join(", ")],
    ...optional("merges at", draft.schedule.merge_at),
    ...optional("schedule error", draft.schedule.last_error),
    ["created by", draft.created_by.name ?? draft.created_by.type],
    ["updated at", draft.updated_at],
    ...Object.entries(draft.data),
  ])
}

export function registerDrafts(
  program: Command,
  context: () => CommandContext
) {
  const drafts = program
    .command("drafts")
    .description(
      "Changes to a record that wait until they are merged into it, now or later"
    )

  withPaging(
    drafts
      .command("list")
      .description("List a collection's drafts, most recently changed first")
      .argument("<collection>", "collection slug or ID")
      .option(
        "--record <id>",
        "this record's draft instead, whatever its collection"
      ),
    "draft"
  ).action(
    async (collection: string, options: PageOptions & { record?: string }) => {
      const ctx = context()
      const query = pageQuery(options)
      await printList(
        ctx,
        options.all,
        () =>
          options.record
            ? ctx.api.records.drafts(options.record, query)
            : ctx.api.drafts.list(collection, query),
        draftTable
      )
    }
  )

  drafts
    .command("get")
    .description(
      "Show a draft, with the record's values as they read after the merge"
    )
    .argument("<draft>", "draft ID (drf_...)")
    .option(
      "--expand <fields>",
      "relation fields whose records to embed (comma-separated)"
    )
    .action(async (id: string, options: { expand?: string }) => {
      const ctx = context()
      const draft = await unwrap(
        ctx.api.drafts.get(id, { expand: options.expand?.split(",") })
      )
      printResult(ctx, draft, () => draftDetails(draft))
    })

  withDataFlags(
    drafts
      .command("create")
      .description(
        "Start a record's draft from its values (the given fields over them), or from an earlier revision"
      )
      .argument("<record>", "record ID")
      .option(
        "--from-revision <n>",
        "start from this revision's values instead of the record's"
      )
  ).action(
    async (
      record: string,
      options: DataOptions & { fromRevision?: string }
    ) => {
      const ctx = context()
      const data = await readData(ctx.runtime, options, {
        required: options.fromRevision === undefined,
      })
      const draft = await unwrap(
        ctx.api.drafts.create(
          record,
          {
            ...(Object.keys(data).length > 0 && { data }),
            ...(options.fromRevision !== undefined && {
              from_revision: positiveInteger(
                options.fromRevision,
                "--from-revision"
              ),
            }),
          },
          ctx.writeOptions()
        )
      )
      printResult(
        ctx,
        draft,
        () =>
          `Started ${draft.id} for ${draft.record_id} (changes ${draft.changed_fields.join(", ") || "nothing yet"}). Merge it with: nohead drafts merge ${draft.id}`
      )
    }
  )

  withDataFlags(
    drafts
      .command("update")
      .description(
        "Change a draft; only the given fields change (null clears one)"
      )
      .argument("<draft>", "draft ID (drf_...)")
      .option(...IF_REVISION)
  ).action(
    async (id: string, options: DataOptions & { ifRevision?: string }) => {
      const ctx = context()
      const data = await readData(ctx.runtime, options)
      const draft = await unwrap(
        ctx.api.drafts.update(
          id,
          { data },
          { ...ctx.writeOptions(), ...ifMatch(options.ifRevision) }
        )
      )
      printResult(
        ctx,
        draft,
        () => `Updated ${draft.id} (revision ${draft.revision})`
      )
    }
  )

  drafts
    .command("merge")
    .description(
      "Apply a draft to its record now, as one revision (the record stays live or not)"
    )
    .argument("<draft>", "draft ID (drf_...)")
    .option(...IF_REVISION)
    .action(async (id: string, options: { ifRevision?: string }) => {
      const ctx = context()
      const record = await unwrap(
        ctx.api.drafts.merge(id, {
          ...ctx.writeOptions(),
          ...ifMatch(options.ifRevision),
        })
      )
      printResult(
        ctx,
        record,
        () => `Merged ${id} into ${record.id} (revision ${record.revision})`
      )
    })

  drafts
    .command("discard")
    .description("Delete a draft for good (the record is unchanged)")
    .argument("<draft>", "draft ID (drf_...)")
    .option(...IF_REVISION)
    .option("--yes", "confirm: a discarded draft cannot be restored", false)
    .action(
      async (id: string, options: { ifRevision?: string; yes: boolean }) => {
        const ctx = context()
        if (!options.yes)
          throw usageError(`Refusing to discard ${id} without --yes`)
        const draft = await unwrap(
          ctx.api.drafts.discard(id, {
            ...ctx.writeOptions(),
            ...ifMatch(options.ifRevision),
          })
        )
        printResult(ctx, draft, () => `Discarded ${draft.id}`)
      }
    )

  drafts
    .command("schedule")
    .description("Merge a draft later (within a minute of the time)")
    .argument("<draft>", "draft ID (drf_...)")
    .requiredOption("--merge-at <time>", "ISO 8601 time, or +2h / +3d")
    .action(async (id: string, options: { mergeAt: string }) => {
      const ctx = context()
      const mergeAt = parseTime(
        options.mergeAt,
        "--merge-at",
        ctx.runtime.now()
      )
      if (mergeAt === null)
        throw usageError(
          `--merge-at needs a time; cancel with: nohead drafts unschedule ${id}`
        )
      const draft = await unwrap(
        ctx.api.drafts.schedule(id, { merge_at: mergeAt }, ctx.writeOptions())
      )
      printResult(
        ctx,
        draft,
        () => `${draft.id} merges at ${draft.schedule.merge_at}`
      )
    })

  drafts
    .command("unschedule")
    .description("Cancel a draft's scheduled merge")
    .argument("<draft>", "draft ID (drf_...)")
    .action(async (id: string) => {
      const ctx = context()
      const draft = await unwrap(
        ctx.api.drafts.unschedule(id, ctx.writeOptions())
      )
      printResult(
        ctx,
        draft,
        () => `Cancelled the scheduled merge of ${draft.id}`
      )
    })
}
