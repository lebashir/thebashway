#!/usr/bin/env bash
# Install the thebashway SKILL into the user's skills dir by symlinking skill/
# (so the source of truth stays version-controlled in this repo). Idempotent.
# This installs the METHOD globally; the ENGINE is wired per-project (see README).
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/skill" && pwd -P)"
DEST_DIR="$HOME/.claude/skills"
DEST="$DEST_DIR/thebashway"

mkdir -p "$DEST_DIR"
if [ -L "$DEST" ] || [ -e "$DEST" ]; then
  rm -rf "$DEST"
fi
ln -s "$SRC" "$DEST"
echo "installed thebashway skill: $DEST -> $SRC"
