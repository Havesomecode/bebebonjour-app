#!/usr/bin/env bash
set -euo pipefail

secret_file="${HERMES_HOME:-$HOME/.hermes}/.env"
backend_token="$(python3 -c '
import ast, pathlib, sys
key = "BEBEBONJOUR_CUSTOMER_FLOW_BACKEND_TOKEN"
for line in pathlib.Path(sys.argv[1]).read_text().splitlines():
    if line.startswith(key + "="):
        raw = line.split("=", 1)[1]
        try:
            print(ast.literal_eval(raw) if raw[:1] in "\"\x27" else raw)
        except (SyntaxError, ValueError):
            print(raw.strip("\"\x27"))
        break
' "$secret_file")"

if [[ -z "$backend_token" ]]; then
  printf 'Missing BEBEBONJOUR_CUSTOMER_FLOW_BACKEND_TOKEN in %s\n' "$secret_file" >&2
  exit 78
fi

CONVEX_URL="https://tacit-antelope-577.convex.cloud" \
CUSTOMER_FLOW_BACKEND_TOKEN="$backend_token" \
BEBEBONJOUR_KANBAN_WORKSPACE="dir:/Users/zacariachtatar/repos/bebebonjour-app/.worktrees/convex-intake-bridge" \
node "$(dirname "$0")/dispatch-intakes-to-kanban.mjs"
