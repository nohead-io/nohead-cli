# Changelog

Changes to the `nohead` CLI (`@nohead/cli`, and `nohead`, which runs it) that
you can notice. Versions follow [Semantic Versioning](https://semver.org):
new commands and options are minor releases; a change that could break your
scripts (output, exit codes, flags) is a major one. Each release's section is
its GitHub release's notes.

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
