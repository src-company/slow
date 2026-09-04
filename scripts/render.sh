#!/usr/bin/env bash
# Regenerate the render gallery and the screenshots.
#
# `--force` is not optional. A forge script embeds the creation bytecode of what
# it deploys at ITS compile time, so if only SLOWNext.sol changed, forge sees the
# script unchanged and replays the OLD contract — the gallery then shows art that
# no longer exists, silently and convincingly. That has happened twice.
set -euo pipefail
cd "$(dirname "$0")/.."
# `--force` only on the script. A full --force rebuild recompiles every
# dependency through via-IR and gets solc OOM-killed in a small container; the
# incremental build is enough for the contract, and the script is the only thing
# that needs forcing, because it embeds the creation bytecode of what it deploys
# at ITS compile time.
forge build >/dev/null
forge script script/RenderGallery.s.sol:RenderGallery --force >/dev/null
node scripts/gallery.mjs
node scripts/shoot.mjs
