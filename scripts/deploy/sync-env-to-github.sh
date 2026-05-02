#!/usr/bin/env bash
#
# One-shot bootstrap: pull the current production env files from the VPS
# and push their contents into GitHub as Repository-level Secrets/Variables.
#
# Run this once after introducing the GitHub-as-source-of-truth flow.
# After running, the values on the VPS and in GitHub will agree, and from
# that point onward the deploy pipeline rewrites the VPS env files from
# GitHub on every run.
#
# Requirements on the local machine:
#   - SSH access to the web/worker VPS via the `remarka-web` / `remarka-worker`
#     aliases (or `web` / `worker` — adjust SSH_WEB / SSH_WORKER below).
#   - `gh` CLI authenticated against the `511231097-lang/remarka` repo.
#
# Idempotent. Safe to re-run. Existing secrets/variables are overwritten with
# the values currently on the VPS.
#
# Usage:
#   ./scripts/deploy/sync-env-to-github.sh           # do it
#   ./scripts/deploy/sync-env-to-github.sh --dry-run # just print what would change

set -euo pipefail

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
  echo "[dry-run] no changes will be pushed to GitHub"
fi

SSH_WEB="${SSH_WEB:-remarka-web}"
SSH_WORKER="${SSH_WORKER:-remarka-worker}"

# Names that are sensitive — go to `gh secret set`.
# Everything else goes to `gh variable set`. Edit both lists if a new
# variable's classification differs from the default.
SECRET_NAMES=(
  AUTH_SECRET
  DATABASE_URL
  VERTEX_API_KEY
  BOOKS_S3_ACCESS_KEY_ID
  BOOKS_S3_SECRET_ACCESS_KEY
  ARTIFACTS_S3_ACCESS_KEY_ID
  ARTIFACTS_S3_SECRET_ACCESS_KEY
  YANDEX_CLIENT_SECRET
  CAPTCHA_SECRET_KEY
  # INTERNAL_WORKER_TOKEN — left out: showcase builder is disabled, no
  # consumer needs it. If the showcase pipeline gets revived, add it back
  # here AND wire it into the render-step in .github/workflows/pipeline.yml.
)

is_secret() {
  local name="$1"
  for s in "${SECRET_NAMES[@]}"; do
    [[ "$s" == "$name" ]] && return 0
  done
  return 1
}

push_value() {
  local name="$1"
  local value="$2"
  local kind

  if is_secret "$name"; then
    kind="secret"
  else
    kind="variable"
  fi

  if [[ "$DRY_RUN" -eq 1 ]]; then
    if [[ "$kind" == "secret" ]]; then
      echo "[dry-run] gh secret set $name = (redacted, ${#value} chars)"
    else
      echo "[dry-run] gh variable set $name = $value"
    fi
    return
  fi

  if [[ "$kind" == "secret" ]]; then
    printf '%s' "$value" | gh secret set "$name" --body -
    echo "  ✓ secret  $name"
  else
    # gh variable set doesn't accept --body - reliably across versions, so
    # pass the value as a positional. Variables aren't sensitive so the
    # exposure in process listing is fine.
    gh variable set "$name" --body "$value" >/dev/null
    echo "  ✓ var     $name = $value"
  fi
}

sync_from_host() {
  local label="$1"
  local ssh_target="$2"
  local remote_path="$3"

  echo
  echo "==> Reading $remote_path from $ssh_target ($label)"

  local content
  if ! content=$(ssh "$ssh_target" "sudo cat $remote_path" 2>/dev/null); then
    echo "::error:: failed to read $remote_path from $ssh_target"
    return 1
  fi

  while IFS= read -r line; do
    # Skip comments / blank lines.
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
    # KEY=VALUE shape only.
    [[ "$line" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]] || continue
    local key="${BASH_REMATCH[1]}"
    local value="${BASH_REMATCH[2]}"
    # Some installers add quotes; strip a single matching pair.
    if [[ "$value" =~ ^\".*\"$ ]] || [[ "$value" =~ ^\'.*\'$ ]]; then
      value="${value:1:-1}"
    fi
    push_value "$key" "$value"
  done <<<"$content"
}

echo "=== Syncing web.env from $SSH_WEB"
sync_from_host "web" "$SSH_WEB" "/srv/remarka/shared/env/web.env"

echo
echo "=== Syncing worker.env from $SSH_WORKER"
sync_from_host "worker" "$SSH_WORKER" "/srv/remarka/shared/env/worker.env"

echo
echo "=== (Optional) Vertex ranking keyfile"
echo "If you use the Vertex semantic ranker, push the JSON keyfile into a"
echo "secret named VERTEX_RANKING_KEYFILE_JSON. The deploy pipeline will"
echo "ship it back to the VPS automatically:"
echo
echo "  ssh $SSH_WEB sudo cat /srv/remarka/shared/secrets/vertex-ranking.json | \\"
echo "    gh secret set VERTEX_RANKING_KEYFILE_JSON --body -"
echo
echo "Done. Subsequent deploys read from GitHub and overwrite the VPS env files."
