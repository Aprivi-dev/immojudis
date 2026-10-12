"use client";

import { useRef } from "react";
import { formatDate, formatPrice } from "@/lib/format";
import Link from "next/link";
import { pathWithSearch, saleDetailPath } from "@/lib/navigation";
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

const ROWS: { label: string; value: (sale: ComparedSale) => string }[] = [
  {
    label: "Commune",
    value: (sale) => [sale.city, sale.department].filter(Boolean).join(" · ") || "À préciser",
  },
  { label: "Type de vente", value: (sale) => VENUE_LABELS[sale.venueType] },
  { label: "Date de vente", value: (sale) => formatDate(sale.saleDate) },
  { label: "Mise à prix", value: (sale) => formatPrice(sale.startingPriceEur) },
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

  return (
    <div
      ref={tableRegionRef}
      role="region"
      aria-label="Tableau comparatif, défilement horizontal et vertical"
      tabIndex={0}
      className="overflow-auto outline-offset-[-2px] focus-visible:outline-2 focus-visible:outline-gold"
    >
      <table
        className="w-full table-fixed border-collapse text-left text-sm"
        style={{ minWidth: 140 + items.length * 220 }}
      >
        <caption className="sr-only">Comparaison des {items.length} biens sélectionnés</caption>
        <thead>
          <tr>
            <th
              scope="col"
              className="sticky left-0 top-0 z-20 w-[140px] border-b border-r border-line-soft bg-surface-tint p-3 align-bottom text-xs font-bold text-ink-soft"
            >
              Critères
            </th>
            {items.map((sale, index) => (
              <th
                key={sale.id}
                scope="col"
                className="sticky top-0 z-10 border-b border-r border-line-soft bg-white p-4 align-top"
              >
                <p className="text-xs font-bold text-brand-navy">Bien {index + 1}</p>
                <p className="mt-1 break-words font-extrabold">{comparedSaleTitle(sale)}</p>
                <div className="mt-2 flex flex-wrap items-center gap-x-3">
                  <Link
                    href={pathWithSearch(saleDetailPath(sale.id), { from: returnTo })}
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
                className="sticky left-0 z-10 border-b border-r border-line-soft bg-surface-tint p-3 text-xs font-bold"
              >
                {row.label}
              </th>
              {items.map((sale) => (
                <td
                  key={sale.id}
                  className="break-words border-b border-r border-line-soft px-4 py-3 tabular-nums"
                >
                  {row.value(sale)}
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
