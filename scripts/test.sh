#!/usr/bin/env bash
# Run the whole suite, without the stale-artifact failure mode.
#
# WHY THE `touch`. `type(C).creationCode` is resolved when the file REFERENCING
# it is compiled, not when C changes. `testGateAddressIsCreate2Predictable`
# predicts the gate's CREATE2 address from `keccak256(type(SLOWGate).creationCode)`,
# and SLOWGate lives in src/SLOW.sol — so editing that file moves the gate's
# metadata hash while a cached test artifact still predicts the old address. The
# test then fails on a change that could not have caused it.
#
# That has cost real time: a correct change was very nearly reverted on this
# signal. It can also go the other way and hide a real move.
#
# scripts/render.sh already forces around exactly this hazard for the gallery
# script, in its own words: "forge sees the script unchanged and replays the OLD
# contract... That has happened twice." The tests had no such guard.
#
# A full `--force` rebuild recompiles every dependency through via-IR and gets
# solc OOM-killed in a small container, which is why this touches only the test
# files that bake in a creationCode constant rather than forcing the world.
set -euo pipefail
cd "$(dirname "$0")/.."

# Every test that embeds `type(...).creationCode`, found rather than listed, so
# a new one is covered the day it is written.
mapfile -t BAKED < <(grep -rl 'type(.*)\.creationCode' test/ 2>/dev/null || true)
if [ ${#BAKED[@]} -gt 0 ]; then
  echo "forcing recompile of ${#BAKED[@]} test file(s) that bake in creationCode:"
  printf '  %s\n' "${BAKED[@]}"
  touch "${BAKED[@]}"
fi

# The README is copied into docs/src/README.md as forge doc's home page, and
# nothing regenerates it — so it drifted a whole deployment behind before anyone
# noticed. Cheap to check, and the failure is a one-command fix.
echo "── docs ──────────────────────────────────────────────"
node scripts/syncdocs.mjs --check

FORGE_ARGS=()
[ "${1:-}" = "--fork" ] || FORGE_ARGS+=(--no-match-path 'test/*Fork*')

echo
echo "── forge ─────────────────────────────────────────────"
forge test "${FORGE_ARGS[@]}"

echo
echo "── node ──────────────────────────────────────────────"
status=0
for t in test/*.test.mjs; do
  [ -e "$t" ] || continue
  echo "· $t"
  node "$t" || status=1
done

# The page suite again, against the artifact that actually gets deployed. This
# is the equivalence check for `scripts/minify.mjs`: not an argument that the
# strip preserves behaviour, but the same six-hundred-odd assertions passing on
# its output. `dapp/page.min.html` is what `manifest.page` points at.
if [ -f dapp/page.min.html ]; then
  echo "· test/page.test.mjs  (against dapp/page.min.html)"
  PAGE=dapp/page.min.html node test/page.test.mjs || status=1
fi

# The rehearsal is not a `*.test.mjs`, so the glob above never ran it — and it
# sat broken across two page changes because of that. It reads whatever chunk
# set is in `out/`, which is gitignored build output, so the one thing it could
# not notice was that it was rehearsing a page nobody was going to deploy. It
# builds its own chunks now, and it runs here so the next page change cannot
# quietly un-rehearse the deployment.
if command -v anvil >/dev/null 2>&1; then
  echo "· test/deploy.rehearsal.mjs"
  node test/deploy.rehearsal.mjs || status=1
else
  echo "· test/deploy.rehearsal.mjs — SKIPPED, no anvil on PATH"
fi

exit $status
