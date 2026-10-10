"use client";

import BarChart3 from "lucide-react/dist/esm/icons/bar-chart-3.js";
import Building2 from "lucide-react/dist/esm/icons/building-2.js";
import CalendarDays from "lucide-react/dist/esm/icons/calendar-days.js";
import LockKeyhole from "lucide-react/dist/esm/icons/lock-keyhole.js";
import Ruler from "lucide-react/dist/esm/icons/ruler.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import { DPE_CLASSES, dpeColor } from "@/lib/dpe";
import type { DpeExplorerResponse } from "@/lib/dpe-explorer";
import { formatPrice, formatPricePerM2, propertyTypeLabel } from "@/lib/format";
import Link from "next/link";
import { cleanSaleTitle } from "@/lib/sale-title";
import type { SearchStatistics } from "./search-page-state";

export function SearchStatisticsPanel({
  statistics,
  locked,
  dpeLocked,
  loading,
  dpeExplorer,
  dpeExplorerLoading,
  dpeExplorerError,
  dpeExplorerRequested,
  onLoadDpeExplorer,
}: {
  statistics: SearchStatistics;
  locked: boolean;
  dpeLocked: boolean;
  loading: boolean;
  dpeExplorer?: DpeExplorerResponse;
  dpeExplorerLoading: boolean;
  dpeExplorerError: string | null;
  dpeExplorerRequested: boolean;
  onLoadDpeExplorer: () => void;
}) {
  if (locked) {
    return (
      <div className="border-b border-brand-navy/10 bg-white px-4 py-4 sm:px-5">
        <h2 className="text-sm font-bold text-brand-navy">
          Repérez un bien, puis préparez votre analyse
        </h2>
        <p className="mt-1 text-sm leading-relaxed text-ink-soft">
          Le compte gratuit ouvre la fiche et la localisation complète. Analyse ajoute les
          comparables, les risques et le calcul de votre enchère plafond.
        </p>
        <Link
          href="/annonce-exemple"
          className="mt-2 inline-flex min-h-10 items-center text-sm font-bold text-brand-navy underline underline-offset-4"
        >
          Essayer une analyse complète sans compte
        </Link>
      </div>
    );
  }

  const items = [
    {
      label: "Prix médian",
      value: formatPrice(statistics.medianPrice),
      icon: <Building2 className="h-4 w-4" />,
    },
    {
      label: "Prix médian / m²",
      value: formatPricePerM2(statistics.medianPricePerM2),
      icon: <Ruler className="h-4 w-4" />,
    },
    {
      label: "Score moyen",
      value: statistics.averageScore == null ? "—" : `${Math.round(statistics.averageScore)}/100`,
      icon: <ShieldCheck className="h-4 w-4" />,
    },
    {
      label: "DPE repérés",
      value: statistics.dpeKnownCount.toLocaleString("fr-FR"),
      icon: <CalendarDays className="h-4 w-4" />,
      locked: dpeLocked,
    },
  ];

  return (
    <div className="border-b border-brand-navy/10 bg-white px-4 py-3 sm:px-5">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-[11px] font-extrabold uppercase tracking-[0.14em] text-brand-navy">
          <BarChart3 className="h-4 w-4" />
          Repères sur votre recherche
        </div>
        {locked ? (
          <span className="inline-flex items-center gap-1 rounded-md border border-sand bg-surface px-2 py-1 text-[10px] font-bold text-gold-text">
            <LockKeyhole className="h-3 w-3" />
            Analyse
          </span>
        ) : null}
      </div>
      <dl className="grid grid-cols-2 gap-2">
        {items.map((item) => (
          <div
            key={item.label}
            className="min-w-0 rounded-md border border-line-soft bg-surface-muted px-3 py-2"
          >
            <dt className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-ink-soft">
              <span className="text-brand-navy">{item.icon}</span>
              {item.label}
            </dt>
            <dd className="mt-0.5 text-sm font-extrabold tabular-nums text-brand-navy">
              {loading ? "…" : item.locked ? "Réservé à Analyse" : item.value}
            </dd>
          </div>
        ))}
      </dl>
      {!dpeLocked && !loading ? (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {DPE_CLASSES.map((dpeClass) => {
              const color = dpeColor(dpeClass);
              return (
                <span
                  key={dpeClass}
                  className="inline-flex min-h-7 items-center gap-1 rounded-md border px-2 text-xs font-bold"
                  style={{
                    backgroundColor: color?.background,
                    borderColor: color?.border,
                    color: color?.foreground,
                  }}
                >
                  {dpeClass}
                  <span className="tabular-nums">{statistics.dpeCounts[dpeClass]}</span>
                </span>
              );
            })}
            <button
              type="button"
              onClick={onLoadDpeExplorer}
              disabled={dpeExplorerLoading}
              className="ml-auto inline-flex min-h-7 items-center rounded-md border border-line bg-white px-2.5 text-xs font-extrabold text-brand-navy hover:border-brand-navy disabled:cursor-not-allowed disabled:opacity-60"
            >
              {dpeExplorerLoading
                ? "Chargement DPE..."
                : dpeExplorerRequested
                  ? "Actualiser DPE"
                  : "Explorer DPE"}
            </button>
          </div>
          {dpeExplorer ? (
            <div className="mt-3 rounded-md border border-line-soft bg-white p-3">
              <div className="grid gap-2 text-xs sm:grid-cols-3">
                <DpeExplorerMetric label="DPE trouvés" value={dpeExplorer.summary.total} />
                <DpeExplorerMetric
                  label="Classes connues"
                  value={dpeExplorer.summary.knownClassCount}
                />
                <DpeExplorerMetric label="Points carte" value={dpeExplorer.summary.mapPointCount} />
              </div>
              {dpeExplorer.items.length ? (
                <div className="mt-3 divide-y divide-brand-navy/10 border-t border-brand-navy/10">
                  {dpeExplorer.items.slice(0, 3).map((item) => (
                    <div key={item.id} className="grid gap-1 py-2 text-xs sm:grid-cols-[1fr_auto]">
                      <div className="min-w-0">
                        <Link
                          className="font-bold text-brand-navy hover:text-brand-navy"
                          href={`/sales/${item.id}`}
                        >
                          {cleanSaleTitle(item.title) ?? "Vente judiciaire"}
                        </Link>
                        <div className="mt-0.5 text-ink-soft">
                          {[item.city, item.department, propertyTypeLabel(item.propertyType)]
                            .filter(Boolean)
                            .join(" · ")}
                        </div>
                      </div>
                      <span className="font-extrabold text-brand-navy">
                        {item.dpeLabel ?? "DPE repéré"}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-3 border-t border-brand-navy/10 pt-3 text-xs text-ink-soft">
                  Aucun DPE repéré avec ces filtres.
                </p>
              )}
            </div>
          ) : null}
          {dpeExplorerError ? (
            <p className="mt-2 text-xs font-bold text-red-700">{dpeExplorerError}</p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
export function DpeExplorerMetric({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-ink-soft">{label}</div>
      <div className="mt-1 text-sm font-extrabold tabular-nums text-brand-navy">
        {value.toLocaleString("fr-FR")}
      </div>
    </div>
  );
}
