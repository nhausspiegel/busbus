#!/usr/bin/env bash
# Re-freeze the GTFS feed, for BOTH tests and the deployed app.
#
# public/gtfs/ is shipped with the build because the static zip is the one
# Passio endpoint that sends no CORS header -- a browser cannot fetch it
# directly, so it must be served from our own origin. The realtime feeds are
# CORS-open and are always fetched live.
#
# Run monthly, or when feed_end_date approaches. Inspect the diff: a test that
# fails here is telling you Passio changed something.
set -euo pipefail
cd "$(dirname "$0")/.."
UA='busbus/0.1 (fixture refresh)'
B=https://passio3.com/brown/passioTransit/gtfs

curl -sS -H "User-Agent: $UA" "$B/google_transit.zip" -o test/fixtures/gtfs.zip
cp test/fixtures/gtfs.zip public/gtfs/google_transit.zip

# The realtime fixture is only worth capturing while buses are actually out.
#
# Run when nothing is running -- which is most of the time -- the endpoint
# returns a valid, EMPTY feed of about 15 bytes. Overwriting with it leaves the
# suite green while silently deleting the coverage of every test that exists to
# exercise the live path against real Passio data. That happened: five tests
# stopped testing anything and nothing failed to say so.
#
# So this refuses to replace a fixture that has trips with one that has none.
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
curl -sS -H "User-Agent: $UA" "$B/realtime/tripUpdates" -o "$TMP"
NEW=$(wc -c < "$TMP" | tr -d ' ')
OLD=$(wc -c < test/fixtures/tripUpdates.pb 2>/dev/null || echo 0)
# A feed with any trip in it is far bigger than the empty header.
if [ "$NEW" -lt 100 ] && [ "$OLD" -ge 100 ]; then
  echo "tripUpdates: live feed is empty (${NEW}B) -- KEEPING the existing ${OLD}B fixture."
  echo "             Recapture while shuttles are running, or the live-path tests test nothing."
else
  cp "$TMP" test/fixtures/tripUpdates.pb
  echo "tripUpdates: refreshed (${NEW}B)."
fi

echo "refreshed. gtfs.zip=$(wc -c < test/fixtures/gtfs.zip)B"
# feed_end_date is the LAST field of the data row, not of the file: feed_info.txt
# ends with a trailing newline, so `tail -1` was reading a blank line and the
# printed date came from whatever awk found there.
unzip -p test/fixtures/gtfs.zip feed_info.txt \
  | awk -F, 'NR==1{for(i=1;i<=NF;i++) if($i ~ /feed_end_date/) c=i; next}
             NF>1{print "feed valid through: " $c; exit}'
