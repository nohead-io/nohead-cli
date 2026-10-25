import { basename } from "node:path"

import { Option, type Command } from "commander"
import mime from "mime"

import type { Asset, AssetKind } from "@nohead/sdk"
import { imageUrl } from "@nohead/sdk/images"
import type { CommandContext } from "../context.ts"
import { CliError, ExitCode, unwrap } from "../errors.ts"
import { usageError } from "../input.ts"
import { details, printNotice, printResult, table } from "../output.ts"
import { pageQuery, printList, withPaging, type PageOptions } from "../pages.ts"

/** The file's type by its extension, for example image/png for cover.png. */
export function contentTypeFor(path: string): string {
  return mime.getType(path) ?? "application/octet-stream"
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  return kb < 1024 ? `${kb.toFixed(1)} KB` : `${(kb / 1024).toFixed(1)} MB`
}

/**
 * The longest an upload attempt may take: the file at 64 KB/s (a slow
 * connection), and at least a minute. 100 MB gets about 27 minutes.
 */
const uploadTimeout = (bytes: number) => Math.max(60_000, bytes / 64)

/**
 * Uploads a file the platform way: start the upload, PUT the bytes
 * straight to storage, then complete it. With a key, a re-run picks up where
 * it stopped (the SDK returns an asset the first run finished).
 */
export async function uploadAsset(
  ctx: CommandContext,
  file: { bytes: Uint8Array; filename: string; contentType: string },
  idempotencyKey?: string
): Promise<Asset> {
  const api = await ctx.project()
  return unwrap(
    api.assets.upload(
      new Uint8Array(file.bytes),
      { filename: file.filename, content_type: file.contentType },
      {
        ...ctx.writeOptions(idempotencyKey ?? null),
        timeout: uploadTimeout(file.bytes.byteLength),
      }
    )
  )
}

function describe(asset: Asset): string {
  return details([
    ["id", asset.id],
    ["filename", asset.filename],
    ...(asset.alt ? ([["alt", asset.alt]] as [string, string][]) : []),
    ["type", asset.content_type],
    ["size", size(asset.byte_size)],
    ...(asset.width && asset.height
      ? ([["pixels", `${asset.width}×${asset.height}`]] as [string, string][])
      : []),
    ["status", asset.deleted_at ? "deleted" : asset.status],
  ])
}

export function registerAssets(
  program: Command,
  context: () => CommandContext
) {
  const assets = program
    .command("assets")
    .description("Manage the project's files (media)")

  withPaging(
    assets
      .command("list")
      .description("List assets, newest first")
      .option("--deleted", "list deleted assets instead", false)
      .option(
        "--search <words>",
        "only assets whose filename or alt text has every word"
      )
      .option(
        "--kind <kinds>",
        `only assets of a kind, or several: ${ASSET_KINDS.join(", ")} (comma-separated)`
      ),
    "asset"
  ).action(
    async (
      options: PageOptions & {
        deleted: boolean
        search?: string
        kind?: string
      }
    ) => {
      const ctx = context()
      // Checked first, so a typo fails before any request.
      const kind = options.kind === undefined ? undefined : kinds(options.kind)
      const query = {
        ...pageQuery(options),
        deleted: options.deleted,
        // An empty search (an unset shell variable) means no search.
        q: options.search || undefined,
        kind,
      }
      const api = await ctx.project()
      await printList(
        ctx,
        options.all,
        () => api.assets.list(query),
        (items) =>
          table(
            ["ID", "FILENAME", "TYPE", "SIZE", "STATUS"],
            items.map((a) => [
              a.id,
              a.filename,
              a.content_type,
              size(a.byte_size),
              a.status,
            ])
          )
      )
    }
  )

  assets
    .command("upload")
    .description("Upload files; prints their asset IDs for use in records")
    .argument("<files...>", "files to upload")
    .option(
      "--content-type <type>",
      "override the type guessed from the extension"
    )
    .action(async (files: string[], options: { contentType?: string }) => {
      const ctx = context()
      await ctx.project()
      const uploaded: Asset[] = []
      for (const path of files) {
        let bytes: Uint8Array
        try {
          bytes = await ctx.runtime.readBinaryFile(path)
        } catch {
          throw usageError(`Cannot read ${path}`)
        }
        const asset = await uploadAsset(ctx, {
          bytes,
          filename: basename(path),
          contentType: options.contentType ?? contentTypeFor(path),
        })
        printNotice(ctx, `Uploaded ${asset.filename}`)
        uploaded.push(asset)
      }
      printResult(ctx, { data: uploaded }, () =>
        uploaded.map((a) => a.id).join("\n")
      )
    })

  assets
    .command("get")
    .description("Show an asset")
    .argument("<id>", "asset ID (ast_...)")
    .action(async (id: string) => {
      const ctx = context()
      const asset = await unwrap(ctx.api.assets.get(id))
      printResult(ctx, asset, () => describe(asset))
    })

  assets
    .command("update")
    .description("Rename an asset or set its alt text")
    .argument("<id>", "asset ID (ast_...)")
    .option("--filename <name>", "new filename (downloads use it)")
    .option(
      "--alt <text>",
      'alt text: what the image shows, the default wherever it is used ("" clears it)'
    )
    .action(
      async (id: string, options: { filename?: string; alt?: string }) => {
        const ctx = context()
        if (options.filename === undefined && options.alt === undefined)
          throw usageError("Nothing to update: pass --filename or --alt")
        const asset = await unwrap(
          ctx.api.assets.update(
            id,
            {
              ...(options.filename !== undefined
                ? { filename: options.filename }
                : {}),
              ...(options.alt !== undefined
                ? { alt: options.alt || null }
                : {}),
            },
            ctx.writeOptions()
          )
        )
        printResult(ctx, asset, () => `Updated ${asset.filename}`)
      }
    )

  assets
    .command("url")
    .description("Print an image's URL, resized, cropped or converted")
    .argument("<id>", "asset ID (ast_...)")
    .option("--width <px>", "width in pixels")
    .option("--height <px>", "height in pixels")
    .addOption(
      new Option("--fit <fit>", "how the image fills width and height")
        .choices(FITS)
        .default("contain")
    )
    .addOption(
      new Option("--format <format>", "the image format")
        .choices(["original", ...FORMATS])
        .default("original")
    )
    .option("--quality <n>", "1-100")
    .action(
      async (
        id: string,
        options: {
          width?: string
          height?: string
          fit: Fit
          format: Format | "original"
          quality?: string
        }
      ) => {
        const ctx = context()
        const url = renditionUrl(await unwrap(ctx.api.assets.get(id)), options)
        printResult(ctx, { url }, () => url)
      }
    )

  assets
    .command("download")
    .description("Download the original file")
    .argument("<id>", "asset ID (ast_...)")
    .option("--output <file>", "where to save it (default: its filename)")
    .option("--force", "replace the file if it exists")
    .action(
      async (id: string, options: { output?: string; force?: boolean }) => {
        const ctx = context()
        const asset = await unwrap(ctx.api.assets.get(id))
        // The file as uploaded, under the asset's file_url; none until the
        // upload is completed.
        if (!asset.file_url)
          throw new CliError(ExitCode.ApiError, {
            type: "not_uploaded",
            message: `Asset ${asset.id} has no file yet: its upload was never completed`,
          })
        const response = await ctx.runtime.fetch(new Request(asset.file_url))
        if (!response.ok)
          throw new CliError(ExitCode.ApiError, {
            type: "download_failed",
            message: `Storage returned ${response.status}`,
          })
        // The filename is anyone's choice, so nothing is replaced without
        // --force, and a dotfile (".pnpmfile.cjs", ".envrc", which tools run
        // from the current directory) is saved under the asset's ID.
        const name = basename(asset.filename)
        const output =
          options.output ??
          (name && !name.startsWith(".") ? name : `${asset.id}${name}`)
        try {
          await ctx.runtime.writeFile(
            output,
            new Uint8Array(await response.arrayBuffer()),
            { exclusive: !options.force }
          )
        } catch (error) {
          if ((error as { code?: string }).code !== "EEXIST") throw error
          throw usageError(
            `${output} already exists; pass --force to replace it`
          )
        }
        printResult(
          ctx,
          { asset_id: id, file: output },
          () => `Saved ${asset.filename} to ${output}`
        )
      }
    )

  assets
    .command("delete")
    .description("Delete an asset (kept for 30 days; restore brings it back)")
    .argument("<id>", "asset ID (ast_...)")
    .action(async (id: string) => {
      const ctx = context()
      const asset = await unwrap(ctx.api.assets.delete(id, ctx.writeOptions()))
      printResult(
        ctx,
        asset,
        () =>
          `Deleted ${asset.filename}. Restore it with: nohead assets restore ${asset.id}`
      )
    })

  assets
    .command("restore")
    .description("Restore a deleted asset")
    .argument("<id>", "asset ID (ast_...)")
    .action(async (id: string) => {
      const ctx = context()
      const asset = await unwrap(ctx.api.assets.restore(id, ctx.writeOptions()))
      printResult(ctx, asset, () => `Restored ${asset.filename}`)
    })
}

const FITS = ["contain", "cover", "fill"] as const
type Fit = (typeof FITS)[number]
const FORMATS = ["webp", "avif", "jpeg", "png"] as const
type Format = (typeof FORMATS)[number]
const ASSET_KINDS: AssetKind[] = [
  "image",
  "video",
  "audio",
  "document",
  "other",
]

/**
 * `--kind image,video` as the kinds, checked, so a typo is a usage error.
 * Empty pieces (`image,`) are skipped.
 */
function kinds(value: string): AssetKind[] {
  const names = value
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
  if (names.length === 0)
    throw usageError(`--kind takes ${ASSET_KINDS.join(", ")}`)
  return names.map((name) => {
    const kind = ASSET_KINDS.find((k) => k === name)
    if (!kind)
      throw usageError(`--kind takes ${ASSET_KINDS.join(", ")}, not "${name}"`)
    return kind
  })
}

/**
 * An image's URL with imgproxy's options for these (`imageUrl` from
 * `@nohead/sdk/images`): image URLs are open, so renditions need no request.
 * Checks the options first, so a typo is a usage error.
 */
function renditionUrl(
  asset: Asset,
  options: {
    width?: string
    height?: string
    fit: Fit
    format: Format | "original"
    quality?: string
  }
): string {
  if (!asset.image_url)
    throw usageError(
      `${asset.id} has no image URL: it isn't a ready JPEG, PNG, GIF, WebP or AVIF image`
    )
  const number = (name: string, value: string | undefined, max: number) => {
    if (value === undefined) return undefined
    const parsed = Number(value)
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > max)
      throw usageError(`--${name} takes a whole number from 1 to ${max}`)
    return parsed
  }
  return imageUrl(asset, {
    width: number("width", options.width, 4096),
    height: number("height", options.height, 4096),
    quality: number("quality", options.quality, 100),
    fit: options.fit,
    format: options.format === "original" ? undefined : options.format,
  })
}
