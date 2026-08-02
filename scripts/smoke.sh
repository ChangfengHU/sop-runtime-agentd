#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${SOP_AGENTD_BASE_URL:-http://127.0.0.1:8789}"
TOKEN="${SOP_AGENTD_INTERNAL_TOKEN:-}"
AUTH_ARGS=()
if [[ -n "$TOKEN" ]]; then
  AUTH_ARGS=(-H "Authorization: Bearer $TOKEN")
fi

curl -fsS "${AUTH_ARGS[@]}" "$BASE_URL/health" | jq -e '.ok == true' >/dev/null
curl -fsS "${AUTH_ARGS[@]}" -X POST "$BASE_URL/v1/adapters/probe" | jq -e '.adapters | all(.ok == true)' >/dev/null
curl -fsS "${AUTH_ARGS[@]}" "$BASE_URL/v1/providers" | jq -e '.providers | type == "array"' >/dev/null
printf 'sop-runtime-agentd smoke passed\n'
