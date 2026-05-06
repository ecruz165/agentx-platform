[200~#!/usr/bin/env bash
# github-copilot-device-auth.sh
set -euo pipefail

CLIENT_ID="Iv1.b507a08c87ecfe98"
SCOPE="read:user"
TOKEN_FILE="$HOME/.config/copilot-cli/oauth_token"
EMBED_MODEL="text-embedding-3-large"

COPILOT_HEADERS=(
  -H "Editor-Version: vscode/1.95.0"
  -H "Editor-Plugin-Version: copilot-chat/0.20.0"
  -H "Copilot-Integration-Id: vscode-chat"
  -H "Openai-Intent: conversation-panel"
  -H "User-Agent: GitHubCopilotChat/0.20.0"
)

# ---------- helpers ----------------------------------------------------------

device_login() {
  echo "Starting GitHub device login..."
  local resp device_code user_code verify_uri interval poll err token
  resp=$(curl -sS -X POST https://github.com/login/device/code \
    -H "Accept: application/json" \
    -d "client_id=$CLIENT_ID" -d "scope=$SCOPE")

  device_code=$(jq -r '.device_code'     <<<"$resp")
  user_code=$(jq -r   '.user_code'       <<<"$resp")
  verify_uri=$(jq -r  '.verification_uri'<<<"$resp")
  interval=$(jq -r    '.interval'        <<<"$resp")

  cat <<EOF

  User code: $user_code
  Visit:     $verify_uri

EOF
  command -v pbcopy >/dev/null && { echo -n "$user_code" | pbcopy; echo "(code copied to clipboard)"; }
  command -v open   >/dev/null && open "$verify_uri"

  echo "Polling every ${interval}s..."
  while :; do
    sleep "$interval"
    poll=$(curl -sS -X POST https://github.com/login/oauth/access_token \
      -H "Accept: application/json" \
      -d "client_id=$CLIENT_ID" \
      -d "device_code=$device_code" \
      -d "grant_type=urn:ietf:params:oauth:grant-type:device_code")
    token=$(jq -r '.access_token // empty' <<<"$poll")
    if [[ -n "$token" ]]; then
      mkdir -p "$(dirname "$TOKEN_FILE")"
      umask 077 && echo "$token" > "$TOKEN_FILE"
      echo "✓ OAuth token saved to $TOKEN_FILE"
      printf '%s' "$token"
      return 0
    fi
    err=$(jq -r '.error // "unknown"' <<<"$poll")
    case "$err" in
      authorization_pending) printf '.' ;;
      slow_down)             interval=$((interval + 5)) ;;
      expired_token)         echo; echo "✗ expired"; return 1 ;;
      access_denied)         echo; echo "✗ denied";  return 1 ;;
      *)                     echo; echo "✗ $poll";   return 1 ;;
    esac
  done
}

# Returns Copilot token on stdout, or non-zero if the gho_ token is bad
exchange_copilot_token() {
  local gho="$1" resp http body code
  resp=$(curl -sS -w "\n%{http_code}" \
    -H "Authorization: token $gho" \
    -H "Accept: application/json" \
    https://api.github.com/copilot_internal/v2/token)
  code=$(tail -n1 <<<"$resp")
  body=$(sed '$d' <<<"$resp")
  if [[ "$code" != "200" ]]; then
    return 1
  fi
  jq -r '.token' <<<"$body"
}

# ---------- 1. obtain gho_ token (cache first) -------------------------------

if [[ -s "$TOKEN_FILE" ]]; then
  GHO_TOKEN=$(<"$TOKEN_FILE")
  echo "✓ Using cached OAuth token at $TOKEN_FILE"
else
  GHO_TOKEN=$(device_login) || exit 1
fi

# ---------- 2. exchange for Copilot token (re-auth on failure) ---------------

if ! COPILOT_TOKEN=$(exchange_copilot_token "$GHO_TOKEN"); then
  echo "⚠ Cached token rejected (revoked or expired) — re-running device login"
  rm -f "$TOKEN_FILE"
  GHO_TOKEN=$(device_login) || exit 1
  COPILOT_TOKEN=$(exchange_copilot_token "$GHO_TOKEN") || {
    echo "✗ Copilot token exchange failed even after re-login"; exit 1; }
fi
echo "✓ Copilot token issued"

# ---------- Test 1: general access -------------------------------------------

echo
echo "── Test 1: GET /models ──────────────────────────────"
MODELS_RESP=$(curl -sS -w "\n%{http_code}" \
  -H "Authorization: Bearer $COPILOT_TOKEN" \
  "${COPILOT_HEADERS[@]}" \
  https://api.githubcopilot.com/models)
HTTP_CODE=$(tail -n1 <<<"$MODELS_RESP")
BODY=$(sed '$d' <<<"$MODELS_RESP")

if [[ "$HTTP_CODE" != "200" ]]; then
  echo "✗ /models HTTP $HTTP_CODE"
  jq . <<<"$BODY" 2>/dev/null || echo "$BODY"
  exit 1
fi
echo "✓ Authenticated. $(jq '.data | length' <<<"$BODY") models visible."
echo "  Embedding models:"
jq -r '.data[] | select(.capabilities.type=="embeddings") | "    - \(.id)  (\(.vendor // "—"))"' <<<"$BODY"

# ---------- Test 2: specific model -------------------------------------------

echo
echo "── Test 2: access to $EMBED_MODEL ────────────────────"
LISTED=$(jq --arg m "$EMBED_MODEL" '.data[] | select(.id==$m)' <<<"$BODY")
[[ -n "$LISTED" ]] && echo "✓ $EMBED_MODEL listed in catalog." \
                   || echo "⚠ $EMBED_MODEL NOT listed — trying live call anyway"

EMBED_RESP=$(curl -sS -w "\n%{http_code}" -X POST \
  -H "Authorization: Bearer $COPILOT_TOKEN" \
  -H "Content-Type: application/json" \
  "${COPILOT_HEADERS[@]}" \
  -d "{\"model\":\"$EMBED_MODEL\",\"input\":[\"hello world\"]}" \
  https://api.githubcopilot.com/embeddings)
EMBED_CODE=$(tail -n1 <<<"$EMBED_RESP")
EMBED_BODY=$(sed '$d' <<<"$EMBED_RESP")

case "$EMBED_CODE" in
  200) echo "✓ vector dim=$(jq '.data[0].embedding | length' <<<"$EMBED_BODY"), tokens=$(jq -r '.usage.total_tokens // "?"' <<<"$EMBED_BODY")" ;;
  400) echo "✗ HTTP 400:"; jq . <<<"$EMBED_BODY" 2>/dev/null || echo "$EMBED_BODY" ;;
  401|403) echo "✗ HTTP $EMBED_CODE — plan does not grant access"; jq -r '.error.message // .message // .' <<<"$EMBED_BODY" 2>/dev/null || echo "$EMBED_BODY" ;;
  404) echo "✗ HTTP 404 — unknown model id" ;;
  *)   echo "✗ HTTP $EMBED_CODE"; jq . <<<"$EMBED_BODY" 2>/dev/null || echo "$EMBED_BODY" ;;
esac
