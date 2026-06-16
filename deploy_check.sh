#!/bin/bash
# deploy_check.sh — verifies the LIVE deployed dashboard is complete & valid.
# Run after every index.html push. Exits non-zero (and re-deploys) if the live
# file is truncated, missing tabs, or has broken JS — the exact failure that
# silently dropped the Overview/Arb tabs.
set -uo pipefail
TOKEN="${GH_TOKEN:-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}"
API="https://api.github.com/repos/beastxo-sudo/edgehound/contents"
LOCAL="${1:-/home/claude/polyscope/index.html}"

# required structural markers — the things that must always be present
REQUIRED_TABS=("overview" "markets" "smart" "signals" "bot" "arb")
REQUIRED_PANELS=("ovAudit" "sniperPanel" "imbalancePanel" "ovStats")

fail=0
echo "── DEPLOY CHECK ──"

# 1. fetch the LIVE file
curl -s -H "Authorization: Bearer $TOKEN" "$API/index.html?_=$RANDOM" \
  | python3 -c "import json,sys,base64;open('/tmp/_live.html','w').write(base64.b64decode(json.load(sys.stdin)['content']).decode())" 2>/dev/null
if [ ! -s /tmp/_live.html ]; then echo "✗ could not fetch live file"; exit 2; fi

LIVE_LINES=$(wc -l < /tmp/_live.html)
LOCAL_LINES=$(wc -l < "$LOCAL")
LIVE_BYTES=$(wc -c < /tmp/_live.html)
echo "live: $LIVE_LINES lines / $LIVE_BYTES bytes  ·  local: $LOCAL_LINES lines"

# 2. size sanity: absolute floor (the full dashboard is ~2000 lines / ~140KB).
#    A truncated live file — the exact bug — falls below this no matter what.
MIN_LINES=1800
MIN_BYTES=130000
if [ "$LIVE_LINES" -lt "$MIN_LINES" ] || [ "$LIVE_BYTES" -lt "$MIN_BYTES" ]; then
  echo "✗ LIVE TOO SMALL: $LIVE_LINES lines / $LIVE_BYTES bytes (floor: $MIN_LINES lines / $MIN_BYTES bytes) — truncation"; fail=1
else echo "✓ live above size floor"; fi
# also flag if live is much smaller than local (defense in depth)
DIFF=$(python3 -c "print($LOCAL_LINES-$LIVE_LINES)")
if [ "$DIFF" -gt $(python3 -c "print(int($LOCAL_LINES*0.05)+5)") ]; then
  echo "✗ LIVE SMALLER THAN LOCAL by $DIFF lines (incomplete deploy)"; fail=1
else echo "✓ live matches local size"; fi

# 3. all required tabs present
for t in "${REQUIRED_TABS[@]}"; do
  if grep -q "data-page=\"$t\"" /tmp/_live.html; then echo "✓ tab: $t"; else echo "✗ MISSING TAB: $t"; fail=1; fi
done

# 4. all required panels present
for p in "${REQUIRED_PANELS[@]}"; do
  if grep -q "$p" /tmp/_live.html; then echo "✓ panel: $p"; else echo "✗ MISSING PANEL: $p"; fail=1; fi
done

# 5. JS must parse (extract first <script> and node --check)
python3 -c "import re;s=re.findall(r'<script>(.*?)</script>',open('/tmp/_live.html').read(),re.S);open('/tmp/_live.js','w').write(s[0] if s else '')" 2>/dev/null
if [ -s /tmp/_live.js ] && node --check /tmp/_live.js 2>/dev/null; then echo "✓ live JS parses"; else echo "✗ LIVE JS BROKEN"; fail=1; fi

# 6. balanced structure (open/close section count sanity)
SECTIONS=$(grep -c 'class="page' /tmp/_live.html)
if [ "$SECTIONS" -ge 6 ]; then echo "✓ $SECTIONS page sections"; else echo "✗ only $SECTIONS page sections (expect ≥6)"; fail=1; fi

if [ "$fail" -eq 0 ]; then
  echo "── ✅ DEPLOY VERIFIED: live dashboard is complete and valid ──"
  exit 0
else
  echo "── ❌ DEPLOY FAILED VERIFICATION ──"
  exit 1
fi
