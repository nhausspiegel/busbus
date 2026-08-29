import type { StyleSpecification, FilterSpecification, ExpressionSpecification } from "maplibre-gl";

/** Basemap style for busbus.
 *
 *  Written from scratch against OpenFreeMap's OpenMapTiles vector source
 *  rather than using a stock style: a shuttle map wants quiet land, legible
 *  roads and nothing else competing, because five saturated route colours are
 *  drawn on top and they carry the meaning. Stock styles are built to be
 *  interesting on their own, which is exactly wrong here.
 *
 *  OpenFreeMap is keyless and unmetered, which keeps the project's
 *  no-API-keys-ever rule intact. */

interface Palette {
  land: string; water: string; green: string; building: string;
  road: string; roadCase: string; roadMinor: string;
  label: string; labelHalo: string; labelMinor: string;
}

const LIGHT: Palette = {
  land: "#F4F0EB", water: "#BBD4E2", green: "#E0E7D8", building: "#E9E2D9",
  road: "#FFFFFF", roadCase: "#E1D9D0", roadMinor: "#FAF7F3",
  label: "#5C5049", labelHalo: "#F7F4F0", labelMinor: "#8A7D74",
};

const DARK: Palette = {
  land: "#1A1613", water: "#16242E", green: "#1E241C", building: "#241E1A",
  road: "#3B332D", roadCase: "#120F0D", roadMinor: "#2A2420",
  label: "#B5ABA2", labelHalo: "#15110F", labelMinor: "#7E736B",
};

const SRC = "openmaptiles";

/** OSM tags its own transit stops as POIs. We draw Brown's shuttle stops
 *  ourselves, and RIPTA's "Thayer before Cushing" markers sitting beside them
 *  are noise a rider would misread as ours. */
const NOT_TRANSIT: ExpressionSpecification =
  ["!", ["in", ["get", "class"], ["literal", ["bus", "railway", "ferry_terminal", "aerialway"]]]];

/** Named, reasonably prominent, and not a transit stop. */
const placeFilter = (maxRank: number): FilterSpecification =>
  ["all", ["has", "name"], ["<=", ["get", "rank"], maxRank], NOT_TRANSIT];

/** Attribution required by OpenFreeMap and OpenStreetMap. */
export const BASEMAP_ATTRIBUTION =
  '<a href="https://openfreemap.org">OpenFreeMap</a> · ' +
  '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap</a>';

export function basemapStyle(dark: boolean): StyleSpecification {
  const c = dark ? DARK : LIGHT;
  const major = ["motorway", "trunk", "primary"];
  const mid = ["secondary", "tertiary"];

  return {
    version: 8,
    glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
    sources: {
      [SRC]: {
        type: "vector",
        url: "https://tiles.openfreemap.org/planet",
        attribution: BASEMAP_ATTRIBUTION,
      },
    },
    layers: [
      { id: "bg", type: "background", paint: { "background-color": c.land } },

      { id: "green", type: "fill", source: SRC, "source-layer": "landcover",
        filter: ["in", "class", "wood", "grass", "scrub"],
        paint: { "fill-color": c.green, "fill-opacity": 0.75 } },
      { id: "park", type: "fill", source: SRC, "source-layer": "park",
        paint: { "fill-color": c.green, "fill-opacity": 0.65 } },

      { id: "water", type: "fill", source: SRC, "source-layer": "water",
        paint: { "fill-color": c.water } },

      // Buildings appear late; below z15 they are noise at this scale.
      { id: "building", type: "fill", source: SRC, "source-layer": "building",
        minzoom: 14.5,
        paint: {
          "fill-color": c.building,
          "fill-opacity": ["interpolate", ["linear"], ["zoom"], 14.5, 0, 16, 0.85],
        } },

      // Casing under fill on every road class: it is what stops a dense street
      // grid reading as a single grey mass.
      { id: "road-minor-case", type: "line", source: SRC, "source-layer": "transportation",
        filter: ["in", "class", "minor", "service", "track"], minzoom: 13,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": c.roadCase,
          "line-width": ["interpolate", ["exponential", 1.4], ["zoom"], 13, 1.5, 18, 9] } },
      { id: "road-minor", type: "line", source: SRC, "source-layer": "transportation",
        filter: ["in", "class", "minor", "service", "track"], minzoom: 13,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": c.roadMinor,
          "line-width": ["interpolate", ["exponential", 1.4], ["zoom"], 13, 0.6, 18, 7] } },

      { id: "road-mid-case", type: "line", source: SRC, "source-layer": "transportation",
        filter: ["in", "class", ...mid],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": c.roadCase,
          "line-width": ["interpolate", ["exponential", 1.4], ["zoom"], 10, 1.6, 18, 14] } },
      { id: "road-mid", type: "line", source: SRC, "source-layer": "transportation",
        filter: ["in", "class", ...mid],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": c.road,
          "line-width": ["interpolate", ["exponential", 1.4], ["zoom"], 10, 0.8, 18, 11] } },

      { id: "road-major-case", type: "line", source: SRC, "source-layer": "transportation",
        filter: ["in", "class", ...major],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": c.roadCase,
          "line-width": ["interpolate", ["exponential", 1.4], ["zoom"], 8, 2, 18, 20] } },
      { id: "road-major", type: "line", source: SRC, "source-layer": "transportation",
        filter: ["in", "class", ...major],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": c.road,
          "line-width": ["interpolate", ["exponential", 1.4], ["zoom"], 8, 1, 18, 16] } },

      { id: "path", type: "line", source: SRC, "source-layer": "transportation",
        filter: ["==", "class", "path"], minzoom: 15,
        paint: { "line-color": c.roadCase, "line-width": 1, "line-dasharray": [2, 2] } },

      // Labels last, and sparse: the sheet answers the question, the map only
      // has to make the answer locatable.
      { id: "road-label", type: "symbol", source: SRC, "source-layer": "transportation_name",
        minzoom: 14,
        layout: {
          "text-field": ["get", "name"],
          "text-font": ["Noto Sans Regular"],
          "symbol-placement": "line",
          "text-size": ["interpolate", ["linear"], ["zoom"], 14, 10, 18, 13],
        },
        paint: { "text-color": c.labelMinor, "text-halo-color": c.labelHalo, "text-halo-width": 1.4 } },

      { id: "water-label", type: "symbol", source: SRC, "source-layer": "water_name",
        layout: { "text-field": ["get", "name"], "text-font": ["Noto Sans Italic"], "text-size": 12 },
        paint: { "text-color": c.labelMinor, "text-halo-color": c.labelHalo, "text-halo-width": 1.2 } },

      // Places you can actually go: libraries, cafes, shops, halls. A rider
      // says "take me to the Ratty", not "take me to 41.826, -71.402", so the
      // map has to offer named destinations rather than only bare coordinates.
      // Only once the rider is actually looking at a block, and only the
      // higher-ranked places -- every corner shop at overview zoom competes
      // with the shuttle stops, which are what this map is for.
      { id: "poi", type: "circle", source: SRC, "source-layer": "poi",
        minzoom: 15,
        filter: placeFilter(12),
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 14, 2.5, 17, 4.5],
          "circle-color": c.labelMinor,
          "circle-opacity": 0.7,
        } },
      { id: "poi-label", type: "symbol", source: SRC, "source-layer": "poi",
        minzoom: 15.5,
        filter: placeFilter(8),
        layout: {
          "text-field": ["get", "name"],
          "text-font": ["Noto Sans Regular"],
          "text-size": 11,
          "text-anchor": "top",
          "text-offset": [0, 0.6],
          "text-max-width": 8,
          "text-optional": true,
        },
        paint: { "text-color": c.labelMinor, "text-halo-color": c.labelHalo, "text-halo-width": 1.4 } },
      // Wide invisible tap target, same trick as the stops layer.
      { id: "poi-hit", type: "circle", source: SRC, "source-layer": "poi",
        minzoom: 15,
        filter: placeFilter(12),
        paint: { "circle-radius": 13, "circle-opacity": 0 } },

      { id: "place-label", type: "symbol", source: SRC, "source-layer": "place",
        filter: ["in", "class", "city", "town", "suburb", "neighbourhood"],
        layout: {
          "text-field": ["get", "name"],
          // OpenFreeMap serves exactly three faces -- Regular, Bold and Italic.
          // "Noto Sans Medium" 404s on every glyph range it is asked for, and
          // MapLibre quietly falls back, so the labels drew while the console
          // filled with failed requests for a font that does not exist.
          "text-font": ["Noto Sans Bold"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 10, 12, 16, 15],
          "text-transform": "none",
        },
        paint: { "text-color": c.label, "text-halo-color": c.labelHalo, "text-halo-width": 1.6 } },
    ],
  };
}

