#!/bin/bash
# safe_deploy.sh <local_file> <repo_path> "<commit msg>"
# Deploys a file, then VERIFIES the live result. If verification fails on
# index.html, it automatically re-pushes the known-good local copy.
set -uo pipefail
TOKEN="${GH_TOKEN:-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}"
API="https://api.github.com/repos/beastxo-sudo/edgehound/contents"
LOCAL="$1"; REPO_PATH="$2"; MSG="${3:-update $REPO_PATH}"
DIR="$(dirname "$0")"

deploy(){
  local sha=$(curl -s -H "Authorization: Bearer $TOKEN" "$API/$REPO_PATH" | python3 -c "import json,sys;print(json.load(sys.stdin).get('sha',''))" 2>/dev/null)
  python3 -c "
import json,base64
d={'message':'''$1''','content':base64.b64encode(open('$LOCAL','rb').read()).decode()}
if '$sha': d['sha']='$sha'
print(json.dumps(d))" > /tmp/_dep.json
  curl -s -X PUT -H "Authorization: Bearer $TOKEN" -d @/tmp/_dep.json "$API/$REPO_PATH" | python3 -c "import json,sys;d=json.load(sys.stdin);print('  pushed:',d.get('commit',{}).get('sha','')[:8] if d.get('commit') else 'ERR')"
}

echo "Deploying $REPO_PATH..."
deploy "$MSG"
sleep 3

# only index.html gets the full structural verification
if [ "$REPO_PATH" = "index.html" ]; then
  if GH_TOKEN="$TOKEN" "$DIR/deploy_check.sh" "$LOCAL"; then
    echo "✅ deploy verified"
  else
    echo "⚠ VERIFICATION FAILED — auto-redeploying known-good local copy..."
    deploy "AUTO-ROLLBACK: redeploy verified-good $REPO_PATH"
    sleep 3
    GH_TOKEN="$TOKEN" "$DIR/deploy_check.sh" "$LOCAL" && echo "✅ rollback verified" || echo "❌ STILL FAILING — manual check needed"
  fi
fi
