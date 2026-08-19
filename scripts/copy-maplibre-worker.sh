#!/usr/bin/env bash
# MapLibre loads its worker as a separate ES module that imports a sibling,
# ./maplibre-gl-shared.mjs. Vite's ?url import copies a file verbatim without
# bundling its dependencies, so the sibling is never emitted and the worker
# 404s -- the style then never initialises and the whole map stays blank while
# raster tiles still draw. Copying BOTH files into public/ keeps their relative
# import intact. Regenerated on every dev/build so it cannot drift from the
# installed version; gitignored for the same reason.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p public/maplibre
cp node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs public/maplibre/
cp node_modules/maplibre-gl/dist/maplibre-gl-shared.mjs public/maplibre/
