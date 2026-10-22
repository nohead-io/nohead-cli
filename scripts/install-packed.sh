#!/usr/bin/env bash
# Packs @nohead/cli and the `nohead` alias into $1 (a new temporary directory
# if not given), installs both tarballs in a fresh directory as users get
# them, with their dependencies from npm, and checks `nohead --version` there.
# Run after `npm ci`, which builds dist/.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
packages=${1:-$(mktemp -d)}
mkdir -p "$packages"
packages=$(cd "$packages" && pwd)
version=$(node -p "require('$root/package.json').version")

cd "$root"
npm pack --silent --pack-destination "$packages" >/dev/null
npm pack --silent ./alias --pack-destination "$packages" >/dev/null

installed=$(mktemp -d)
cd "$installed"
npm init --yes >/dev/null
npm install --ignore-scripts --no-audit --no-fund --silent \
  "$packages/nohead-cli-$version.tgz" "$packages/nohead-$version.tgz"
# The first word: the SDK it uses follows, in parentheses.
actual=$(node node_modules/nohead/nohead.js --version | cut -d" " -f1)
if [ "$actual" != "$version" ]; then
  echo "nohead --version printed $actual, not $version" >&2
  exit 1
fi
echo "Packed and installed @nohead/cli and nohead $version in $packages"
