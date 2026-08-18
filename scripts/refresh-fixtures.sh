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
curl -sS -H "User-Agent: $UA" "$B/google_transit.zip"   -o test/fixtures/gtfs.zip
curl -sS -H "User-Agent: $UA" "$B/realtime/tripUpdates" -o test/fixtures/tripUpdates.pb
cp test/fixtures/gtfs.zip public/gtfs/google_transit.zip
echo "refreshed. gtfs.zip=$(wc -c < test/fixtures/gtfs.zip)B  tripUpdates.pb=$(wc -c < test/fixtures/tripUpdates.pb)B"
unzip -p test/fixtures/gtfs.zip feed_info.txt | tail -1 | awk -F, '{print "feed valid through: " $NF}'
