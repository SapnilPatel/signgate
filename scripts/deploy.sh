#!/bin/sh
# Deploys the committed tree to Vercel production from a clean copy.
# The host refuses uploads that include local build caches, and rejects git metadata
# whose author it does not recognise, so only tracked files are sent, without history.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(mktemp -d)"
cd "$ROOT"
git ls-files -z | rsync -a --from0 --files-from=- ./ "$OUT/"
cp -R .vercel "$OUT/.vercel"
cd "$OUT"
vercel deploy --prod --yes
rm -rf "$OUT"
