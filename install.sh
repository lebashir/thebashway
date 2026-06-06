#!/usr/bin/env bash
# Install the thebashway SKILL into the user's skills dir by symlinking the plugin's skill/
# (so the source of truth stays version-controlled in this repo). Idempotent.
# This is the SOURCE-INSTALL path for the method; most users instead get it via the plugin
# marketplace (`claude plugin marketplace add lebashir/thebashway` → `claude plugin install
# thebashway@thebashway`). Either way the ENGINE installs separately (see README).
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/plugins/thebashway/skill" && pwd -P)"
DEST_DIR="$HOME/.claude/skills"
DEST="$DEST_DIR/thebashway"

mkdir -p "$DEST_DIR"
if [ -L "$DEST" ] || [ -e "$DEST" ]; then
  rm -rf "$DEST"
fi
ln -s "$SRC" "$DEST"
echo "installed thebashway skill: $DEST -> $SRC"
