import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";

export const alt = "Immojudis — les enchères immobilières, en toute clarté";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/** Jetons de la marque (`src/styles.css`) : papier, marine, texte doré. */
const PAPER = "#fbf9f5";
const NAVY = "#132238";
const GOLD_TEXT = "#84602e";
const GOLD = "#c98d45";

/** Graisses de Manrope employées par l'image (fichiers statiques de `src/fonts/`). */
const OPEN_GRAPH_FONT_WEIGHTS = [400, 700, 800] as const;

/**
 * Image de partage des pages sans image propre. Marque de la refonte : fond papier, nom « Immojudis »
 * (jamais en capitales), pictogramme du favicon (temple), accroche du site.
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
        <svg width="96" height="96" viewBox="0 0 256 256" fill="none">
          <path
            d="M38 101h180L128 42 38 101Z"
            stroke={NAVY}
            strokeWidth="18"
            strokeLinejoin="round"
          />
          <path
            d="M58 202h140M74 101v82M112 101v82M150 101v82M188 101v82"
            stroke={NAVY}
            strokeWidth="18"
            strokeLinecap="round"
          />
          <path d="M38 216h180" stroke={GOLD} strokeWidth="18" strokeLinecap="round" />
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
