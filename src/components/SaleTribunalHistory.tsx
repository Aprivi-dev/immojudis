"use client";

import { useQuery } from "@tanstack/react-query";
import ArrowUpRight from "lucide-react/dist/esm/icons/arrow-up-right.js";
import BarChart3 from "lucide-react/dist/esm/icons/bar-chart-3.js";
import CircleAlert from "lucide-react/dist/esm/icons/circle-alert.js";
import Landmark from "lucide-react/dist/esm/icons/landmark.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchTribunalStatistics } from "@/lib/tribunal-statistics-client";
import {
  formatProbability,
  formatRatioDelta,
  tribunalSaleCompactMetrics,
} from "@/lib/tribunal-sale-statistics";
import type { AuctionSale } from "@/lib/types";

export function SaleTribunalHistory({ sale }: { sale: AuctionSale }) {
  const courtCode = sale.tribunal_code?.trim() ?? "";
  const query = useQuery({
    queryKey: ["tribunal-statistics", "sale-detail", courtCode, 36],
    queryFn: () => fetchTribunalStatistics({ windowMonths: 36, courtCode }),
    enabled: Boolean(courtCode),
    retry: false,
    staleTime: 5 * 60_000,
  });

  if (!courtCode) {
    return (
      <HistoryNotice
        title="Historique du tribunal en cours de rattachement"
        detail="Immojudis n'affiche aucune statistique tant que le tribunal compétent n'est pas confirmé par le référentiel officiel."
      />
    );
  }

  if (query.isLoading) return <HistorySkeleton />;
  if (query.isError) {
    return (
      <HistoryNotice
        title="Historique temporairement indisponible"
        detail="Immojudis ne remplace pas les résultats vérifiés par des estimations ou des données non contrôlées."
      />
    );
  }

  const item = query.data?.tribunals.find(
    (candidate) =>
      candidate.tribunal?.code.toLocaleLowerCase("fr-FR") === courtCode.toLocaleLowerCase("fr-FR"),
  );
  if (!item) {
    return (
      <HistoryNotice
        title="Données du tribunal en consolidation"
        detail="Aucun instantané compatible et publiable n'est encore disponible sur les 36 derniers mois."
      />
    );
  }

  const metrics = tribunalSaleCompactMetrics(item);
  const insufficient = item.reliability.level === "insufficient_data";

  return (
    <section
      id="tribunal-history"
      className="scroll-mt-36 border-b border-brand-navy/10 bg-white"
      aria-labelledby="tribunal-history-title"
    >
      <div className="mx-auto max-w-[1260px] px-4 py-12 sm:px-6 lg:px-8 lg:py-16">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-gold-soft">
              <Landmark className="h-4 w-4" aria-hidden />
              Historique rattaché à l’adresse du bien
            </p>
            <h2
              id="tribunal-history-title"
              className="mt-2 font-display text-4xl font-medium text-brand-navy sm:text-5xl"
            >
              {item.tribunal?.name ?? sale.tribunal_name ?? sale.tribunal ?? "Tribunal compétent"}
            </h2>
            <p className="mt-3 max-w-3xl text-sm leading-relaxed text-brand-navy/65 sm:text-base">
              Résultats définitifs admissibles sur 36 mois. Les résultats inconnus, non gelés ou non
              suffisamment vérifiés restent hors des valeurs publiées.
            </p>
          </div>
          <ReliabilityBadge level={item.reliability.level} label={item.reliability.label} />
        </div>

        {insufficient ? (
          <div className="mt-7 flex gap-3 border-y border-amber-200 bg-amber-50 px-4 py-5 text-amber-950">
            <CircleAlert className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
            <div>
              <p className="font-semibold">Échantillon insuffisant</p>
              <p className="mt-1 text-sm leading-relaxed">
                Les valeurs locales sont volontairement masquées afin d’éviter une fausse précision.
              </p>
            </div>
          </div>
        ) : (
          <dl className="mt-8 grid overflow-hidden rounded-lg border border-brand-navy/12 bg-[#f8fbfe] sm:grid-cols-2 lg:grid-cols-4">
            <HistoryMetric
              label="Audiences éligibles"
              value={metrics.eligibleRounds == null ? "Non publié" : String(metrics.eligibleRounds)}
              detail={`Couverture connue ${formatProbability(metrics.coverage)}`}
            />
            <HistoryMetric
              label="Hausse sur mise à prix"
              value={formatRatioDelta(metrics.finalToInitialMedian)}
              detail={sampleLabel(metrics.finalToInitialSample)}
              accent
            />
            <HistoryMetric
              label="Taux d'adjudication"
              value={formatProbability(metrics.adjudicatedRate)}
              detail={sampleLabel(metrics.adjudicatedSample)}
            />
            <HistoryMetric
              label="Taux de surenchère"
              value={formatProbability(metrics.overbidRate)}
              detail={sampleLabel(metrics.overbidSample)}
            />
          </dl>
        )}

        <div className="mt-6 flex flex-col gap-3 border-t border-brand-navy/10 pt-5 text-xs leading-relaxed text-brand-navy/58 sm:flex-row sm:items-center sm:justify-between">
          <p className="max-w-3xl">
            Historique descriptif, pas prévision du prix de ce bien. Chaque indicateur conserve son
            propre échantillon et son taux de couverture.
          </p>
          <a
            href="/tribunaux"
            className="inline-flex min-h-10 shrink-0 items-center gap-2 font-semibold text-gold-soft hover:text-gold"
          >
            Voir la méthode complète
            <ArrowUpRight className="h-4 w-4" aria-hidden />
          </a>
        </div>
      </div>
    </section>
  );
}

function HistoryMetric({
  label,
  value,
  detail,
  accent = false,
}: {
  label: string;
  value: string;
  detail: string;
  accent?: boolean;
}) {
  return (
    <div className="border-b border-brand-navy/10 p-5 last:border-b-0 sm:[&:nth-last-child(-n+2)]:border-b-0 lg:border-b-0 lg:border-r lg:last:border-r-0">
      <dt className="text-xs font-semibold uppercase tracking-[0.1em] text-brand-navy/55">
        {label}
      </dt>
      <dd
        className={`mt-3 font-display text-3xl font-semibold tabular-nums ${accent ? "text-gold-soft" : "text-brand-navy"}`}
      >
        {value}
      </dd>
      <p className="mt-2 text-xs text-brand-navy/55">{detail}</p>
    </div>
  );
}

function ReliabilityBadge({ level, label }: { level: string; label: string }) {
  const classes =
    level === "robust"
      ? "border-emerald-200 bg-emerald-50 text-emerald-900"
      : level === "descriptive"
        ? "border-sky-200 bg-sky-50 text-sky-900"
        : "border-amber-200 bg-amber-50 text-amber-950";
  return (
    <span
      className={`inline-flex w-fit items-center gap-2 rounded-md border px-3 py-2 text-xs font-semibold ${classes}`}
    >
      <ShieldCheck className="h-4 w-4" aria-hidden />
      {label}
    </span>
  );
}

function HistoryNotice({ title, detail }: { title: string; detail: string }) {
  return (
    <section id="tribunal-history" className="scroll-mt-36 border-b border-brand-navy/10 bg-white">
      <div className="mx-auto flex max-w-[1260px] gap-4 px-4 py-10 sm:px-6 lg:px-8">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-md bg-gold/10 text-gold-soft">
          <BarChart3 className="h-5 w-5" aria-hidden />
        </span>
        <div>
          <h2 className="font-display text-2xl font-semibold text-brand-navy">{title}</h2>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-brand-navy/62">{detail}</p>
        </div>
      </div>
    </section>
  );
}

function HistorySkeleton() {
  return (
    <section
      id="tribunal-history"
      aria-label="Chargement de l'historique du tribunal"
      className="border-b border-brand-navy/10 bg-white"
    >
      <div className="mx-auto max-w-[1260px] px-4 py-12 sm:px-6 lg:px-8">
        <Skeleton className="h-9 w-96 max-w-full bg-brand-navy/10" />
        <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-28 bg-brand-navy/5" />
          ))}
        </div>
      </div>
    </section>
  );
}

function sampleLabel(sample: number | null): string {
  if (sample == null) return "Échantillon non publié";
  return `${sample} résultat${sample > 1 ? "s" : ""} vérifié${sample > 1 ? "s" : ""}`;
}
