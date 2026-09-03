#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 2 || ! "$1" =~ ^job_[A-Za-z0-9][A-Za-z0-9_-]{2,127}$ ]]; then
  printf 'Usage: %s <job_id> <approval_record_path>\n' "$0" >&2
  exit 64
fi

artifact_root="${BEBEBONJOUR_PRIVATE_ARTIFACT_ROOT:-}"
if [[ -z "$artifact_root" || "$artifact_root" != /* ]]; then
  printf 'BEBEBONJOUR_PRIVATE_ARTIFACT_ROOT must be an absolute pre-created private directory.\n' >&2
  exit 78
fi

approval_path="$2"
if [[ "$approval_path" != /* ]]; then
  printf 'approval_record_path must be absolute and beneath the private artifact root.\n' >&2
  exit 78
fi

secret_file="${HERMES_HOME:-$HOME/.hermes}/.env"
backend_token="$(python3 -c '
import ast, pathlib, stat, sys
secret_path = pathlib.Path(sys.argv[1])
metadata = secret_path.stat()
if stat.S_IMODE(metadata.st_mode) & 0o077:
    raise SystemExit("Hermes secret store permissions must be 0600 or stricter.")
key = "BEBEBONJOUR_CUSTOMER_FLOW_BACKEND_TOKEN"
for line in secret_path.read_text().splitlines():
    if line.startswith(key + "="):
        raw = line.split("=", 1)[1]
        try:
            print(ast.literal_eval(raw) if raw[:1] in "\"\x27" else raw)
        except (SyntaxError, ValueError):
            print(raw.strip("\"\x27"))
        break
' "$secret_file")"

if [[ -z "$backend_token" ]]; then
  printf 'Missing BEBEBONJOUR_CUSTOMER_FLOW_BACKEND_TOKEN in the Hermes secret store.\n' >&2
  exit 78
fi

exec /usr/bin/env -i \
  PATH="$PATH" \
  HOME="$HOME" \
  TMPDIR="${TMPDIR:-/tmp}" \
  CONVEX_URL="https://tacit-antelope-577.convex.cloud" \
  CUSTOMER_FLOW_BACKEND_TOKEN="$backend_token" \
  node "$(dirname "$0")/../ops/run-test-a-generation.mjs" \
    "$1" "$artifact_root" "$approval_path"
