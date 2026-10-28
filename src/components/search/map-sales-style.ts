import type { ExpressionSpecification, Map as MapboxMap } from "mapbox-gl";
import { MAP_PALETTE } from "@/lib/map-palette";

/** Rayons, décalages et icônes des couches de ventes de la carte de /sales (voir `MapPanel`). */

export const PEPITE_ICON_ID = "immojudis-pepite";
export const APPROX_RING_ICON_ID = "immojudis-approx-ring";

/**
 * Rayon d'une vente isolée selon le zoom (22 px à l'échelle de la France : un prix de 5 caractères
 * à 12 px y tient). Le point sélectionné, la cible de clic, le glyphe de pépite et l'anneau en
 * pointillé en dérivent : ils suivent les mêmes paliers de zoom.
 */
const POINT_RADIUS_STOPS = [
  [4, 22],
  [9, 24],
  [14, 29],
] as const;
const zoomStops = (offset: number): ExpressionSpecification => [
  "interpolate",
  ["linear"],
  ["zoom"],
  ...POINT_RADIUS_STOPS.flatMap(([zoom, radius]) => [zoom, radius + offset]),
];
export const POINT_RADIUS = zoomStops(0);
/** Point sélectionné : le rayon du point + 6 px, pour rester visible sous l'anneau de pépite. */
export const ACTIVE_RADIUS = zoomStops(6);
/** Cible de clic : le rayon du point + 4 px. */
export const HIT_RADIUS = zoomStops(4);
/** Anneau en pointillé d'une position approximative, juste hors du trait du point. */
const APPROX_RING_LOGICAL_RADIUS = 29;
export const APPROX_RING_SIZE: ExpressionSpecification = [
  "interpolate",
  ["linear"],
  ["zoom"],
  ...POINT_RADIUS_STOPS.flatMap(([zoom, radius]) => [
    zoom,
    (radius + 5) / APPROX_RING_LOGICAL_RADIUS,
  ]),
];
/** Glyphe de pépite posé sur le bord du disque (rayon × 0,71, sur la diagonale haut-droite). */
export const PEPITE_GLYPH_OFFSET: ExpressionSpecification = [
  "interpolate",
  ["linear"],
  ["zoom"],
  ...POINT_RADIUS_STOPS.flatMap(([zoom, radius]) => {
    const offset = Math.round(radius * 0.71);
    return [zoom, ["literal", [offset, -offset]]];
  }),
];
/** Même règle pour un regroupement, dont le rayon dépend du nombre de ventes (18, 24 ou 30 px). */
export const CLUSTER_RADIUS: ExpressionSpecification = [
  "step",
  ["get", "point_count"],
  18,
  10,
  24,
  30,
  30,
];
export const CLUSTER_GLYPH_OFFSET: ExpressionSpecification = [
  "step",
  ["get", "point_count"],
  ["literal", [13, -13]],
  10,
  ["literal", [17, -17]],
  30,
  ["literal", [21, -21]],
];

/**
 * Glyphe de pépite (caillou à facettes sur une pastille blanche) pour les couches `symbol` : dessiné une fois
 * dans un canvas de 40 px (ratio 2). Sans canvas (environnement sans 2D) : pas de glyphe, l'anneau reste.
 */
export function addPepiteIcon(map: MapboxMap) {
  if (map.hasImage(PEPITE_ICON_ID) || typeof document === "undefined") return;
  const canvas = document.createElement("canvas");
  canvas.width = 40;
  canvas.height = 40;
  const context = canvas.getContext("2d");
  if (!context) return;
  context.fillStyle = MAP_PALETTE.white;
  context.beginPath();
  context.arc(20, 20, 19, 0, Math.PI * 2);
  context.fill();
  const outline: Array<[number, number]> = [
    [9, 17],
    [15, 9],
    [26, 10],
    [32, 18],
    [30, 28],
    [21, 33],
    [11, 30],
    [7, 23],
  ];
  context.beginPath();
  outline.forEach(([x, y], index) => (index ? context.lineTo(x, y) : context.moveTo(x, y)));
  context.closePath();
  context.fillStyle = MAP_PALETTE.gold;
  context.fill();
  context.strokeStyle = MAP_PALETTE.navy;
  context.lineWidth = 1.5;
  context.lineJoin = "round";
  context.stroke();
  context.beginPath();
  for (const [x, y] of [outline[1], outline[3], outline[5], outline[0]]) {
    context.moveTo(18, 19);
    context.lineTo(x, y);
  }
  context.lineWidth = 1;
  context.stroke();
  map.addImage(PEPITE_ICON_ID, context.getImageData(0, 0, 40, 40), { pixelRatio: 2 });
}

/**
 * Anneau en pointillé marine à liseré blanc, dessiné une fois (canvas de 128 px, ratio 2 : 64 px
 * logiques, rayon de l'anneau `APPROX_RING_LOGICAL_RADIUS`). Sans canvas : pas d'anneau.
 */
export function addApproxRingIcon(map: MapboxMap) {
  if (map.hasImage(APPROX_RING_ICON_ID) || typeof document === "undefined") return;
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext("2d");
  if (!context) return;
  const radius = APPROX_RING_LOGICAL_RADIUS * 2;
  context.beginPath();
  context.arc(64, 64, radius, 0, Math.PI * 2);
  context.strokeStyle = MAP_PALETTE.white;
  context.lineWidth = 9;
  context.stroke();
  context.setLineDash([10, 8]);
  context.strokeStyle = MAP_PALETTE.navy;
  context.lineWidth = 5;
  context.stroke();
  map.addImage(APPROX_RING_ICON_ID, context.getImageData(0, 0, 128, 128), { pixelRatio: 2 });
}
