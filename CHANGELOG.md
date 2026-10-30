# Changelog

Changes to the `nohead` CLI (`@nohead/cli`, and `nohead`, which runs it) that
you can notice. Versions follow [Semantic Versioning](https://semver.org):
new commands and options are minor releases; a change that could break your
scripts (output, exit codes, flags) is a major one. Before 1.0, a minor release
may also break scripts, and its notes mark each such change **Breaking**. Each
release's section is its GitHub release's notes.

## Unreleased

- `BROWSER=none` keeps `nohead login` from opening a browser: it only
  prints the page to open, as over SSH.
- `nohead login` signs you in with the browser, at a terminal or run by a
  coding agent (no terminal and nothing on stdin). It prints a code, then
  opens the web app (or, over SSH or without a display, prints the page to
  open), where you check the code and choose the project, the key's scopes
  and its expiry; the CLI waits for you to choose Allow and saves the new
  key for that project, as a piped key is saved. In a folder that uses a
  project (`--project`, `NOHEAD_PROJECT` or a `nohead.json`), it asks for a
  key for that project, the only one the page then offers. The code and the page go to stderr even with `--json`;
  stdout carries the same result as for a piped key. A key piped in
  (`echo "$KEY" | nohead login`) is checked and saved as before.
- **Breaking:** `nohead login` at a terminal no longer asks you to paste an
  API key: it signs you in with the browser. To save a key you already
  have, pipe it in. With nothing on stdin it signs in with the browser too;
  something piped in that holds no key (an unset variable in
  `echo "$KEY"`) still fails with exit code 2, and so does a login with no
  key in CI (`CI` set), which can't wait for a browser.
- **Breaking:** API keys are saved by project, and profiles are gone:
  `--profile` and `NOHEAD_PROFILE` no longer exist. An API key belongs to
  one project, so choosing a project now chooses its saved key: a command
  works in `--project`, else `NOHEAD_PROJECT`, else the project in the
  nearest `nohead.json` (in the current folder or one above it), else the
  project of the only saved key. With keys saved for several projects and
  none chosen, a command exits 2 and lists them. `nohead login` saves a key
  for its project next to other projects' keys (a new key for the same
  project replaces the old one) and says which project it saved;
  `nohead logout` forgets the key of the project in use. Keys saved as
  profiles by earlier versions keep working: each is read as its project's
  key, and the config file is saved in the new shape the next time it
  changes. `NOHEAD_API_KEY` still wins over saved keys, in its own project
  (or `--project`, or `NOHEAD_PROJECT`); `nohead.json` doesn't apply to it.
  With `--json`, `login` prints `replaced` (whether it replaced a saved
  key) instead of `profile`, and `logout` prints `project_id` instead.
- `nohead link <project>` writes `nohead.json` in the current folder,
  `{ "project": "prj_..." }`, so commands run there or below use that
  project and its saved key. It holds no secret: commit it. Linking a
  folder that has one replaces its project and keeps anything else in it.
- `nohead whoami` says which project is in use and where it came from
  (`--project`, `NOHEAD_PROJECT`, a `nohead.json` and its path, the only
  saved key, or `NOHEAD_API_KEY`), and names a folder's `nohead.json` that
  something else overrides; with `--json`, in `project_id`,
  `project_source`, `link_file` and `unused_link_file`.
- `nohead login` says when the key's project isn't the one the folder (or
  `--project`, `NOHEAD_PROJECT`) uses.
- `--api-url` is no longer in `--help`: there is one API,
  `https://api.nohead.io`. It and `NOHEAD_API_URL` still work, for a local
  or test API.
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
  `NOHEAD_API_KEY`, `NOHEAD_API_URL` or `NOHEAD_PROJECT` (say,
  `NOHEAD_API_KEY=` in an `.envrc`) no longer hides the saved key, and an empty `XDG_CONFIG_HOME` no longer moves the
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
- `assets download` and `export --include-files` treat storage that cannot
  be reached like the API: they exit 3 with `network_error` (it was exit 4,
  `Unexpected error`). A download gives up after the time an upload of the
  file may take (a minute, longer for a large file), with the same error.
- Numbers and field types given to a command are checked before it makes
  any request, with the same messages: `fields migrate --type`,
  `--max-length`, `--min` and `--max` on `fields update` and
  `fields migrate` (which looked the field up first), and `assets url`
  `--width`, `--height` and `--quality` (which read the asset first). An
  empty `--if-revision ""` is refused as not a positive integer; it was
  ignored, so the write went ahead unguarded.
- `import` checks `assets.jsonl` (with `--include-files` exports) along
  with the records and drafts, and lists its problems (a line without an
  asset ID, the file missing) in the same `incomplete or damaged` error
  instead of stopping at the first.

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
