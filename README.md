# Nohead CLI

The `nohead` command-line interface for [Nohead](https://nohead.io), for developers, CI and coding agents. It talks to the **public API only**, through the TypeScript SDK, [`@nohead/sdk`](https://www.npmjs.com/package/@nohead/sdk). Every change it makes is recorded in history as made "via the CLI".

```bash
npm install -g @nohead/cli               # or run it without installing: npx nohead
echo "$NOHEAD_API_KEY" | nohead login    # create a key in the web app under API keys
nohead whoami
```

## Example: model testimonials

```bash
nohead collections create testimonials
nohead fields add testimonials name --type text --required
nohead fields add testimonials company --type text
nohead fields add testimonials quote --type long-text --required
nohead fields add testimonials avatar --type asset

nohead --note "Seed" records create testimonials --set name=Ada --set "quote=Great platform"
nohead records update rec_... --set company=Analytical --if-revision 1
nohead records history rec_...
nohead records revert rec_... 1 --dry-run
```

## Commands

| Group         | Commands                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|               | `health`, `whoami`, `flags`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `collections` | `list [--deleted]`, `get <c>`, `create <slug> [--name] [--description]`, `update <c> [--name] [--slug] [--description]`, `delete <c> --yes`, `restore <c>`, `history <c>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `fields`      | `list <c> [--deleted]`, `add <c> <name> --type <type> [--key] [--required] [--multiple] [config flags]`, `update <c> <field> [--name] [--key] [--required\|--optional] [config flags]`, `delete <c> <field>`, `restore <c> <field>`, `migrate <c> <field> [--type] [--multiple\|--single] [--required\|--optional] [--backfill text\|--backfill-json json] [--days-in zone] [--clear-invalid] [--dry-run] [--no-wait] [config flags]`                                                                                                                                                                                                                                                 |
| `schema`      | `pull [--output file\|-]`, `diff [file] [--exit-code] [--no-preview]`, `push [file] --yes [--allow-migrations] [--clear-invalid]`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
|               | `export --output <dir> [--include-history] [--include-deleted]`, `import <dir>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
|               | `login` (API key on stdin), `logout`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `search`      | `search [query] [--collection c] [--filter k=v] [--sort] [--limit]` (one collection, or the whole project)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `webhooks`    | `list`, `create --url <url> [--events a,b\|*] [--description]`, `delete <id>`, `rotate-secret <id>`, `test <id>`, `deliveries <id> [--status]`, `delivery <whd_...>`, `retry <whd_...>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `audit`       | `audit [--type t\|record.*] [--resource id] [--actor usr_\|key_] [--since] [--until] [--limit]` (needs `audit:read`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `assets`      | `list [--deleted] [--search words] [--kind k,k] [--cursor] [--all]`, `upload <files...> [--content-type]`, `get <id>`, `url <id> [--width] [--height] [--fit] [--format] [--quality]`, `download <id> [--output]`, `delete <id>`, `restore <id>`                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `migrations`  | `list <c>`, `get <id> [--wait]`, `cancel <id>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `records`     | `list <c> [--status] [--filter k=v] [--deleted] [--sort] [--limit] [--cursor] [--all]`, `get <id>`, `create <c>`, `update <id> [--if-revision n]`, `publish`/`unpublish`/`delete <id> [--if-revision n]`, `restore <id>`, `schedule <id> [--publish-at t] [--unpublish-at t]`, `unschedule <id>`, `scheduled <c> [--sort -at] [--all]`, `history <id> [--operation] [--actor] [--since] [--until] [--limit] [--cursor]`, `revision <id> <n>`, `diff <id> --from n --to n`, `revert <id> <revision> [--dry-run]`, `export <c> [--output file]`, `import <c> <file\|-> [--publish]`, `bulk <action> <collection> [ids...] [--status\|--filter k=v\|--deleted\|--every] [--set\|--data]` |
| `drafts`      | `list <c> [--record id] [--all]`, `get <drf_...> [--expand]`, `create <record> [--from-revision n]`, `update <drf_...> [--if-revision n]`, `merge <drf_...> [--if-revision n]`, `discard <drf_...> --yes`, `schedule <drf_...> --merge-at t`, `unschedule <drf_...>`                                                                                                                                                                                                                                                                                                                                                                                                                  |

`<c>` is a collection slug or ID (record and draft commands take just the record's or draft's ID, which is unique); `<field>` is a field key or ID. Field types accept `rich-text` or `rich_text`.

Config flags set a field's options: `--description`, `--options a,b` (enum), `--target <c>` (relation), `--max-length n` (plain text), `--min n`/`--max n` (numbers), `--include-time`/`--no-include-time` and `--time-zone <zone>` (dates), `--format slug|url|email`/`--no-format` and `--unique`/`--no-unique` (text), and `--searchable`, `--filterable`, `--sortable` (each with `--no-`). `fields update` merges them into the field's options; turning a date's time on or off is a migration (`fields migrate`), and `--days-in <zone>` says whose day each moment becomes when the time goes.

`--filter` takes `key=value`, `key!=value`, `key<value` (and `>`, `<=`, `>=`), `"key in a,b"` (`\,` for a comma in a value), `"key exists"` and `"key !exists"`; several on one key combine (`--filter price>=10 --filter price<50`). Dates take `today`, and dates with a time `now`. `records list --status published` (or `unpublished`) filters by `published_at`; across a whole project, `search` filters by `"published_at exists"` (or `!exists`) only.

`fields migrate` changes a field in a way that rewrites record values (type, single/multiple, a stricter configuration, or required with a backfill). Run it with `--dry-run` first to see how every record converts. Without `--no-wait` it waits for the background migration and exits non-zero if it fails or is cancelled. The collection is read-only while it runs.

`echo "$KEY" | nohead login` checks the key and saves it, with its API URL and project, as a profile (file mode 0600). Run at a terminal, `nohead login` asks for the key and reads it without echoing it, so it doesn't stay on screen or in scrollback. Flags win over environment variables, which win over the profile.

### Schema as code

`schema pull` writes `nohead.schema.yaml`: collections keyed by slug, fields keyed by key, type options flattened (`options`, `max_length`, `collection: <slug>` for relation targets). Fields can set `searchable`, `filterable` and `sortable` (what API searches match, filter and sort on). `schema diff` shows the plan (`+` add, `~` change, `!` field migration, `·` only in the project) and `schema push --yes` applies it through the API. Push never deletes; collections and fields missing from the file are left alone. Type and single/multiple changes are field migrations and need `--allow-migrations`: each is previewed before anything changes, and push stops if values cannot be converted (unless `--clear-invalid`). Changes that tighten a field (becoming required, new options such as a shorter `max_length`) are checked the same way, so a push that would be refused halfway stops before changing anything. Renaming a key in the file means a new field, unless you say where it came from: `headline: { type: text, renamed_from: title }` renames the `title` field, keeping its values, and `title` stays an alias for six months so clients have time to move. Once pushed, `renamed_from` has nothing left to do and can be removed; `schema pull` never writes it.

### Export and import

`export --output dir` writes `manifest.json`, `schema.yaml`, `records/<slug>.jsonl` (one API record per line), `drafts/<slug>.jsonl` (one API draft per line), `assets.jsonl` (asset metadata) and, with `--include-history`, `history/<slug>.jsonl`; `--include-files` also downloads every original to `assets/<asset id>`. Import re-uploads those files and points asset fields at the copies (without them, asset values are left out). `import dir` creates the schema (never migrating fields), then the records in three passes (create, relink relations to the new IDs, publish/delete as exported), then the drafts on the new records (with the fields they change, relinked, and a merge still to come scheduled again; `base_revision` becomes the new record's revision). Every request has an Idempotency-Key derived from the exported record, so re-running an interrupted import within 24 hours does not duplicate records. Revision history is exported for reference but not replayed: imported records start a new history.

`records import` gives every line its own `Idempotency-Key` derived from the file, so re-running an interrupted import within 24 hours does not create duplicates.

`records schedule` publishes or unpublishes a record later: times are ISO 8601 with a time zone (`2026-10-01T09:00:00Z`), an offset from now (`+30m`, `+2h`, `+3d`, `+1w`), or `none` to clear one; a time left out stays as it is. The change happens within a minute of the time, as its own revision; `records get` shows the schedule and why a scheduled change failed, if it did, and `records scheduled <c>` lists what is coming in a collection (publishes, unpublishes and draft merges, soonest first).

A draft holds changes to a record until it is merged, now (`drafts merge`) or at `--merge-at`, while the record keeps its content; a merge changes content only, so a live record stays live. `drafts create` and `update` take the same data flags as records.

Record data comes from `--set key=text`, `--set key:=json` (numbers, booleans, null, lists, objects), `--data '{...}'` and `--data-file <path|->`. `update` changes only the given fields; `--set key:=null` clears one.

## Configuration

| Setting      | Flag                      | Environment                                                                            |
| ------------ | ------------------------- | -------------------------------------------------------------------------------------- |
| API key      | —                         | `NOHEAD_API_KEY`                                                                       |
| API base URL | `--api-url <url>`         | `NOHEAD_API_URL` (default `https://api.nohead.io`)                                     |
| Project      | `--project <id>`          | `NOHEAD_PROJECT` (default: the API key's project, from `GET /v1/me`)                   |
| Change note  | `--note <text>`           | — (kept with record revisions, merges and schema changes; other writes ignore it)      |
| Idempotency  | `--idempotency-key <key>` | — (sent with mutations; the same key and request return the first result for 24 hours) |

## Output contract

Scripts and agents depend on this, so it is covered by unit and E2E tests:

- **stdout** carries only results. With `--json`, exactly one JSON document (the API's representation). `records export` writes JSON Lines.
- **stderr** carries errors, summaries and diagnostics. With `--json`, errors use the API error envelope `{ "error": { "type", "message", "request_id", "details" } }`.
- **Exit codes:** `0` success, `1` API error (validation, auth, 404, 412, import failures), `2` usage error (bad arguments, missing API key, unreadable files), `3` API unreachable, `4` unexpected CLI failure (a bug; `NOHEAD_DEBUG=1` prints the stack).
- **Retries:** up to 3, reported on stderr. `429` responses are retried after `Retry-After` (up to 60 s). Network failures, `500`, `502`, `503` and `504` are retried with backoff. Every write carries an `Idempotency-Key` (`--idempotency-key`, or a new one per request), so a repeat returns the first result.
- Deleting a collection requires `--yes`. Everything else is soft-deleted and recoverable.

## Development

The CLI calls the API through [`@nohead/sdk`](https://github.com/nohead-io/nohead-typescript), so a command that needs an operation the SDK lacks waits for the SDK release that adds it.

```bash
npm install            # also builds dist/
npm test               # unit tests against API stubs; requests and responses checked against openapi.json
npm run lint && npm run typecheck && npm run format:check
scripts/install-packed.sh   # packs both packages and runs them as users install them
NOHEAD_API_URL=http://localhost:3000 node dist/index.js whoami   # against a local API
```

`openapi.json` is the API's published contract; the tests check every stubbed request and response against it. When the contract changes, the Nohead API repository pushes the new one to the `contract/update` branch, and a pull request follows.

The end-to-end tests run the built CLI against the real API. They live with the API, which runs them on every API change, with this repository's `main` or a local checkout.

## Releasing

The CLI is published as `@nohead/cli`, and as the unscoped `nohead` ([alias](alias)), which runs it so that `npx nohead` works. Both share one version.

1. Set the new version in `package.json` and in `alias/package.json` (its own and the `@nohead/cli` it depends on), then `npm install --package-lock-only`.
2. Add a section for it to `CHANGELOG.md` (`## 1.2.3`), which becomes the release's notes.
3. Merge to `main`. Its ruleset requires the **CI passed** check, so the commit goes through a pull request or a branch whose CI passed, and force pushes are refused.
4. Run the **CLI release** workflow in the Nohead API repository. It runs the end-to-end tests against this commit and pushes the tag `v1.2.3`. Nobody else can push `v*` tags: a tag ruleset lets only that workflow's deploy key through.
5. The tag starts `.github/workflows/release.yml`. A build job checks the tag is on `main` and matches both versions and the notes, and packs both packages, with no publishing credential. Its publishing job runs in the `release` environment, which only `v*` tags can use, and the registry's trusted publishers accept only that environment. It stages both packages on npm with provenance through trusted publishing (no token), then creates a draft GitHub release.
6. Approve `@nohead/cli` first, then `nohead`, with 2FA: on npmjs.com, or with `npm stage list <package>` and `npm stage approve <stage-id>`. Only then are they installable. Publish the draft GitHub release.

## License

MIT
