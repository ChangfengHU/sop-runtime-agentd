#!/usr/bin/env bash
set -euo pipefail
# Prepare only the shared workspace parent, never credentials or existing projects.
CODEx_USER="${SOP_CODEX_EXECUTION_USER:-claude}"
[[ "$CODEx_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || { echo 'Invalid Codex execution user' >&2; exit 1; }
CODEX_USER_HOME="$(getent passwd "$CODEx_USER" | cut -d: -f6)"
[[ "$CODEX_USER_HOME" = /* && -d "$CODEX_USER_HOME" ]] || { echo 'Codex execution user must exist with an absolute HOME' >&2; exit 1; }
CODEX_WORKSPACE_PARENT="$CODEX_USER_HOME/harness"
[[ ! -L "$CODEX_WORKSPACE_PARENT" ]] || { echo 'Codex workspace parent must not be a symlink' >&2; exit 1; }
install -d -m 0750 -o "$CODEx_USER" -g "$(id -gn "$CODEx_USER")" "$CODEX_WORKSPACE_PARENT"
