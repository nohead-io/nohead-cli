# Changelog

Changes to the `nohead` CLI (`@nohead/cli`, and `nohead`, which runs it) that
you can notice. Versions follow [Semantic Versioning](https://semver.org):
new commands and options are minor releases; a change that could break your
scripts (output, exit codes, flags) is a major one. Before 1.0, a minor release
may also break scripts, and its notes mark each such change **Breaking**. Each
release's section is its GitHub release's notes.

## Unreleased

- Every list command pages: `collections list`, `collections history`,
  `fields list`, `migrations list`, `webhooks list`, `webhooks deliveries`
  and `audit` stopped at the first 100 (`audit`: its `--limit`) without
  saying there were more. Like `records list`, they now end with
  `More: --cursor <cursor>` when there are, and take `--limit`, `--cursor`
  and `--all` (every page). `records history` takes `--all` too, and
  `assets list` takes `--limit`. `--all` reads 100 to a page whatever the
  command's default page size. A `--limit` that is not a positive integer
  is refused before any request, by `search` too.
- Commands that take a field key (`fields update`, `fields delete`,
  `fields restore`, `fields migrate`) find a field in a collection with
  more than 100 fields; they looked in the first 100 only.
- An empty environment variable counts as unset, as in the SDKs: an empty
  `NOHEAD_API_KEY`, `NOHEAD_API_URL`, `NOHEAD_PROFILE` or `NOHEAD_PROJECT`
  (say, `NOHEAD_API_KEY=` in an `.envrc`) no longer hides the saved
  profile's setting, and an empty `XDG_CONFIG_HOME` no longer moves the
  config file into the current directory.
- A list page that says there is more but gives no cursor no longer ends
  with `More: --cursor null`; like the SDKs, the CLI stops there.
- With `--json`, usage errors (a missing argument, an unknown command or
  option) print the error envelope on stderr, as other errors do, such as
  `{ "error": { "type": "invalid_request", "message": "missing required argument 'id'" } }`,
  instead of commander's message and the command's help. They still exit 2.
- Options and arguments with a fixed set of values (`records list`,
  `records bulk` and `records export` `--status`, the `records bulk`
  action, `records scheduled --sort`, `assets url --fit` and `--format`,
  `webhooks deliveries --status`) list their choices in `--help`, and refuse
  any other value as other usage errors do, with a new message such as
  `option '--fit <fit>' argument 'crop' is invalid. Allowed choices are contain, cover, fill.`
  `assets url` checks `--fit` and `--format` before any request, and
  `webhooks deliveries --status` before the API sees it. Flags that cannot
  go together (`fields update --required --optional`, and in
  `fields migrate` also `--multiple --single` and `--backfill --backfill-json`)
  say so in the same way: `option '--optional' cannot be used with option '--required'`.

## 0.3.0

- `nohead assets download` and `nohead export --include-files` fetch files
  from the asset's `file_url` (the API's download links are gone), on
  `@nohead/sdk` 0.8.0. **Breaking:** `assets download` now saves a deleted
  asset's file too, until it is purged (it was refused with `deleted`); an
  asset whose upload was never completed has no file, and exits 1 with
  `not_uploaded`.

## 0.2.0

- `nohead assets list --search <words>` finds assets whose filename or alt
  text has every word, and `--kind image,video` lists only assets of those
  kinds (`image`, `video`, `audio`, `document` or `other`). `--all` follows
  every page, and `--cursor` continues from one: without them the list ends
  at 100 with the cursor for the next page, as `records list` does.

- **Breaking (for scripts):** `nohead --version` also prints the SDK version
  it calls the API through, such as `0.2.0 (SDK 0.7.0)`. The CLI's own version stays
  the first word; a script that compares the whole output should read that
  word instead (`nohead --version | cut -d" " -f1`).

## 0.1.0

The first release.

- Install with `npm install -g @nohead/cli`, or run `npx nohead`. It talks to
  `https://api.nohead.io` unless `--api-url` or `NOHEAD_API_URL` says
  otherwise.
- `nohead login` (named profiles; at a terminal it reads the key without
  echoing it), `whoami`, `health`.
- Collections, fields, migrations, records (history, revision, diff, revert,
  bulk, import/export as JSON Lines), drafts (create, update, merge now or on
  a schedule, discard), assets (`assets update --filename --alt` renames one
  and sets its alt text), search, webhooks, audit.
- Schema as code (`schema pull`, `diff`, `push`) and project export/import,
  drafts and assets' alt text included. A push puts fields in the file's
  order with one reorder, after adding new ones.
- `--json` output, stable exit codes (0-4), retries for rate limits and
  transient failures.
- `assets url <id>` builds a rendition URL from the image's `image_url`, with
  no request for it; `--json` prints `{ "url": ... }`.
- `collections create --public-search` and
  `collections update --[no-]public-search` include a collection in public
  search or remove it; `collections search-index` shows the index's name. Schema files carry it
  (`public_search: true`), so schema push and project export/import keep it.
