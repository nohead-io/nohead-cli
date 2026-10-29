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

nohead records create testimonials --set name=Ada --set "quote=Great platform"
nohead records update rec_... --set company=Analytical --if-revision 1 --note "Add the company"
nohead records history rec_...
nohead records revert rec_... 1 --dry-run
```

## Documentation

The [CLI reference](https://docs.nohead.io/cli/overview) covers configuration, output and exit codes, paging and filters, schema as code, export and import, and every command with its arguments and options. `nohead <command> --help` prints the same for one command.

## Development

`commands.json` describes every command for the docs' CLI reference; run `npm run commands` after changing a command (a test fails while it is stale).

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
