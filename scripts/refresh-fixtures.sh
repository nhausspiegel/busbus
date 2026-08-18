#!/usr/bin/env bash
# Re-freeze test fixtures from the live Passio feeds.
# Run this when a test fails because Passio changed its data, NOT to make a
# failing test pass. Inspect the diff before committing.
set -euo pipefail
cd "$(dirname "$0")/.."
UA='busbus/0.1 (fixture refresh)'
B=https://passio3.com/brown/passioTransit/gtfs
curl -sS -H "User-Agent: $UA" "$B/google_transit.zip"   -o test/fixtures/gtfs.zip
curl -sS -H "User-Agent: $UA" "$B/realtime/tripUpdates" -o test/fixtures/tripUpdates.pb
echo "refreshed. gtfs.zip=$(wc -c < test/fixtures/gtfs.zip)B  tripUpdates.pb=$(wc -c < test/fixtures/tripUpdates.pb)B"
