import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import {
  BRAND_BODY_PATH,
  BRAND_ROOF_DOT_RADIUS,
  BRAND_ROOF_DOTS,
  BRAND_TILE_PATH,
} from "@/lib/brand-mark";

export const alt = "Immojudis — les enchères immobilières, en toute clarté";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/** Jetons de la marque (`src/styles.css`) : papier, marine, texte doré. */
const PAPER = "#ece6d3";
const NAVY = "#45201a";
const GOLD_TEXT = "#8f4526";
const GOLD = "#cf8760";
const BORDEAUX = "#56251e";
const IVORY = "#f5f1e6";

/** Graisses de Manrope employées par l'image (fichiers statiques de `src/fonts/`). */
const OPEN_GRAPH_FONT_WEIGHTS = [400, 700, 800] as const;

/**
 * Image de partage des pages sans image propre. Marque de la refonte : fond papier, nom « Immojudis »
 * (jamais en capitales), pictogramme du favicon (fronton), accroche du site.
 *
 * Police : Manrope, la police du site (repasse design n° 38). `ImageResponse` n'accepte que du TTF,
 * de l'OTF ou du WOFF, pas le WOFF2 variable de `src/fonts/` : l'image lit les fichiers statiques
 * `manrope-latin-{400,700,800}.woff` (TrueType dans un conteneur WOFF, licence OFL :
 * `src/fonts/OFL-manrope.txt`). Ils sont lus sur le disque, jamais importés : `next/font` ne les sert
 * pas, et les pages ne chargent toujours qu'un seul fichier de police.
 */
export default async function OpenGraphImage() {
  const [regular, bold, extraBold] = await Promise.all(
    OPEN_GRAPH_FONT_WEIGHTS.map((weight) =>
      readFile(join(process.cwd(), `src/fonts/manrope-latin-${weight}.woff`)),
    ),
  );
  return new ImageResponse(
    <div
      style={{
        alignItems: "flex-start",
        background: PAPER,
        color: NAVY,
        display: "flex",
        flexDirection: "column",
        fontFamily: "Manrope",
        height: "100%",
        justifyContent: "center",
        padding: "80px 96px",
        width: "100%",
      }}
    >
      <div style={{ alignItems: "center", display: "flex" }}>
        <svg width="96" height="96" viewBox="0 0 64 64">
          <path d={BRAND_TILE_PATH} fill={BORDEAUX} />
          {BRAND_ROOF_DOTS.map(([cx, cy]) => (
            <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={BRAND_ROOF_DOT_RADIUS} fill={IVORY} />
          ))}
          <path d={BRAND_BODY_PATH} fill={IVORY} />
        </svg>
        <div
          style={{ color: NAVY, display: "flex", fontSize: 60, fontWeight: 800, marginLeft: 28 }}
        >
          Immojudis
        </div>
      </div>
      <div style={{ background: GOLD, display: "flex", height: 6, marginTop: 40, width: 120 }} />
      <div
        style={{
          display: "flex",
          fontSize: 76,
          fontWeight: 700,
          lineHeight: 1.1,
          marginTop: 40,
        }}
      >
        Les enchères immobilières, en toute clarté
      </div>
      <div style={{ color: GOLD_TEXT, display: "flex", fontSize: 30, marginTop: 36 }}>
        Annonces, procédures expliquées et enchère plafond chiffrée
      </div>
    </div>,
    {
      ...size,
      fonts: [
        { name: "Manrope", data: regular, weight: 400, style: "normal" },
        { name: "Manrope", data: bold, weight: 700, style: "normal" },
        { name: "Manrope", data: extraBold, weight: 800, style: "normal" },
      ],
    },
  );
}
