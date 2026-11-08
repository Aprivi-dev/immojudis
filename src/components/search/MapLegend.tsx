"use client";

import { useId, useState } from "react";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.js";
import ChevronUp from "lucide-react/dist/esm/icons/chevron-up.js";
import { PepiteIcon } from "@/components/PepiteBadge";
import { MAP_ACTIVE_FILL, MAP_PALETTE } from "@/lib/map-palette";
import { PEPITE_LABEL } from "@/lib/pepite-copy";

/**
 * Légende de la carte de /sales (encart du bas de `MapPanel`) : vente, vente survolée, regroupement,
 * position approximative et, s'il y en a, les pépites. Chaque pastille reprend le dessin de sa couche
 * (`map-sales-layers.ts`).
 */
export function MapLegend({ pepiteCount }: { pepiteCount: number }) {
  const [legendOpen, setLegendOpen] = useState(false);
  const legendId = useId();
  return (
    <>
      {/* Mobile : la légende se replie derrière un bouton de 44 px, fermée par défaut (elle prenait
          une centaine de pixels de la carte). Dès `sm`, elle reste affichée, sans bouton. */}
      <button
        type="button"
        aria-expanded={legendOpen}
        aria-controls={legendId}
        onClick={() => setLegendOpen((open) => !open)}
        className="mt-1 inline-flex min-h-11 items-center gap-1.5 rounded-md border border-line-soft bg-white px-3 text-xs font-bold text-brand-navy focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft sm:hidden"
      >
        Légende
        {legendOpen ? (
          <ChevronUp className="size-4" aria-hidden="true" />
        ) : (
          <ChevronDown className="size-4" aria-hidden="true" />
        )}
      </button>
      <ul
        id={legendId}
        className={`mt-1.5 flex-wrap items-center gap-x-3.5 gap-y-1 ${legendOpen ? "flex" : "hidden sm:flex"}`}
        aria-label="Légende de la carte"
      >
        <li className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="inline-block size-3 shrink-0 rounded-full"
            style={{ backgroundColor: MAP_PALETTE.navy }}
          />
          Vente
        </li>
        <li className="inline-flex items-center gap-1.5">
          {/* Même dessin que la couche du point actif : halo or, anneau or foncé. */}
          <span
            aria-hidden="true"
            className="inline-block size-3 shrink-0 rounded-full border-2"
            style={{ backgroundColor: MAP_ACTIVE_FILL, borderColor: MAP_PALETTE.goldSoft }}
          />
          Survolée
        </li>
        <li className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="inline-block size-3 shrink-0 rounded-full border-2 bg-white"
            style={{ borderColor: MAP_PALETTE.navy }}
          />
          Regroupement
        </li>
        <li className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="inline-grid size-3 shrink-0 place-items-center rounded-full border-[1.5px] border-dashed"
            style={{ borderColor: MAP_PALETTE.navy }}
          >
            <span
              className="block size-1.5 rounded-full"
              style={{ backgroundColor: MAP_PALETTE.navy }}
            />
          </span>
          Position approximative
        </li>
        {pepiteCount > 0 ? (
          <li className="inline-flex items-center gap-1.5 font-semibold text-gold-text">
            <PepiteIcon className="size-3.5 shrink-0" />
            <span>
              {PEPITE_LABEL} ({pepiteCount.toLocaleString("fr-FR")}) · anneau doré
            </span>
          </li>
        ) : null}
      </ul>
    </>
  );
}
