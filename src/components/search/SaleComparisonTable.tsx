"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { formatDate, formatPricePerM2, formatStartingPrice, occupancyLabel } from "@/lib/format";
import { pricePerM2 } from "@/lib/geo";
import Link from "next/link";
import { saleDetailPath } from "@/lib/navigation";
import { fetchUnderRangeSaleIds } from "@/lib/search/market-range-filter";
import { fetchPepiteSaleIds } from "@/lib/search/pepite-filter";
import {
  comparedSaleTitle,
  comparisonSurfaceKind,
  type ComparedSale,
} from "@/lib/search/sale-comparison";

const VENUE_LABELS = {
  tribunal: "Au tribunal",
  notary: "Chez le notaire",
  state: "Domaniale",
  online: "À préciser (en ligne)",
  unknown: "À préciser",
};

/**
 * Repères publics lus dans les listes du catalogue (jamais un appel par bien) : `null` tant qu'une
 * liste n'est pas lue, ou quand sa lecture a échoué (la ligne dit alors « Non disponible »).
 */
type PublicSignals = {
  pepiteIds: ReadonlySet<string> | null;
  underRangeIds: ReadonlySet<string> | null;
};

/**
 * Largeurs du tableau : colonne des critères de 80 px (140 px dès `sm`), colonnes de biens de 140 px
 * (180 px dès `sm`). À 360 px, deux biens tiennent à côté des critères.
 */
function usePublicSignals(): PublicSignals {
  const [signals, setSignals] = useState<PublicSignals>({ pepiteIds: null, underRangeIds: null });
  useEffect(() => {
    let active = true;
    fetchPepiteSaleIds().then(
      (pepiteIds) => active && setSignals((current) => ({ ...current, pepiteIds })),
      () => undefined,
    );
    fetchUnderRangeSaleIds().then(
      (underRangeIds) => active && setSignals((current) => ({ ...current, underRangeIds })),
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, []);
  return signals;
}

const ROWS: {
  label: string;
  value: (sale: ComparedSale, signals: PublicSignals) => string;
}[] = [
  { label: "Commune", value: (sale) => sale.city || "À préciser" },
  { label: "Département", value: (sale) => sale.department || "Non renseigné" },
  { label: "Type de vente", value: (sale) => VENUE_LABELS[sale.venueType] },
  { label: "Date de vente", value: (sale) => formatDate(sale.saleDate) },
  { label: "Occupation", value: (sale) => occupancyLabel(sale.occupancy) },
  { label: "Mise à prix", value: (sale) => formatStartingPrice(sale.startingPriceEur) },
  {
    label: "Écart avec le marché",
    value: (sale, { underRangeIds }) =>
      underRangeIds == null
        ? "Non disponible"
        : underRangeIds.has(sale.id.toLowerCase())
          ? "Mise à prix sous le marché"
          : "Non signalé (voir la fiche)",
  },
  {
    label: "Pépite",
    value: (sale, { pepiteIds }) =>
      pepiteIds == null
        ? "Non disponible"
        : pepiteIds.has(sale.id.toLowerCase())
          ? "Pépite"
          : "Pas de repère",
  },
  {
    label: "Mise à prix / m²",
    value: (sale) => {
      const perM2 = pricePerM2(sale.startingPriceEur, sale.surfaceM2);
      return perM2 == null ? "Non calculable" : formatPricePerM2(perM2);
    },
  },
  {
    label: "Surface publiée",
    value: (sale) =>
      sale.surfaceM2 == null
        ? "Non renseignée"
        : `${sale.surfaceM2.toLocaleString("fr-FR", { maximumFractionDigits: 2 })} m²`,
  },
  { label: "Nature de surface", value: comparisonSurfaceKind },
  { label: "Pièces", value: (sale) => formatCount(sale.rooms) },
  { label: "Chambres", value: (sale) => formatCount(sale.bedrooms) },
  { label: "Salles de bains", value: (sale) => formatCount(sale.bathrooms) },
];

export function SaleComparisonTable({
  items,
  returnTo,
  onRemove,
}: {
  items: ComparedSale[];
  returnTo: string;
  onRemove?: (saleId: string) => void;
}) {
  const tableRegionRef = useRef<HTMLDivElement>(null);
  const signals = usePublicSignals();

  return (
    <div
      ref={tableRegionRef}
      role="region"
      aria-label="Tableau comparatif, défilement horizontal et vertical"
      tabIndex={0}
      className="overflow-auto outline-offset-[-2px] focus-visible:outline-2 focus-visible:outline-gold"
    >
      <table
        className="w-full min-w-[calc(80px+var(--compared-count)*140px)] table-fixed border-collapse text-left text-sm sm:min-w-[calc(140px+var(--compared-count)*180px)]"
        style={{ "--compared-count": items.length } as CSSProperties}
      >
        <caption className="sr-only">Comparaison des {items.length} biens sélectionnés</caption>
        <thead>
          <tr>
            <th
              scope="col"
              className="sticky left-0 top-0 z-20 w-[80px] border-b border-r border-line-soft bg-surface-tint p-2 align-bottom text-xs font-bold text-ink-soft sm:w-[140px] sm:p-3"
            >
              Critères
            </th>
            {items.map((sale, index) => (
              <th
                key={sale.id}
                scope="col"
                className="sticky top-0 z-10 w-[140px] border-b border-r border-line-soft bg-white p-3 align-top sm:w-[180px] sm:p-4"
              >
                <p className="text-xs font-bold text-brand-navy">Bien {index + 1}</p>
                <p className="mt-1 break-words font-extrabold">{comparedSaleTitle(sale)}</p>
                <div className="mt-2 flex flex-wrap items-center gap-x-3">
                  <Link
                    href={saleDetailPath(sale.id, returnTo)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex min-h-11 items-center text-xs font-bold text-brand-navy underline underline-offset-2"
                    aria-label={`Voir la fiche du bien ${index + 1} (nouvel onglet)`}
                  >
                    Voir la fiche ↗
                  </Link>
                  {onRemove ? (
                    <button
                      type="button"
                      onClick={() => {
                        tableRegionRef.current?.focus({ preventScroll: true });
                        onRemove(sale.id);
                      }}
                      aria-label={`Retirer le bien ${index + 1} de la comparaison`}
                      className="min-h-11 rounded-md px-1 text-xs font-bold text-ink-soft hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-gold"
                    >
                      Retirer
                    </button>
                  ) : null}
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ROWS.map((row) => (
            <tr key={row.label}>
              <th
                scope="row"
                className="sticky left-0 z-10 border-b border-r border-line-soft bg-surface-tint p-2 text-xs font-bold sm:p-3"
              >
                {row.label}
              </th>
              {items.map((sale) => (
                <td
                  key={sale.id}
                  className="break-words border-b border-r border-line-soft px-3 py-3 tabular-nums sm:px-4"
                >
                  {row.value(sale, signals)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatCount(value: number | null): string {
  return value == null ? "Non renseigné" : value.toLocaleString("fr-FR");
}
