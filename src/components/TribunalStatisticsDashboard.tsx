"use client";

import { useMemo, useState } from "react";
import AlertTriangle from "lucide-react/dist/esm/icons/alert-triangle.js";
import BarChart3 from "lucide-react/dist/esm/icons/bar-chart-3.js";
import Database from "lucide-react/dist/esm/icons/database.js";
import Landmark from "lucide-react/dist/esm/icons/landmark.js";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.js";
import Search from "lucide-react/dist/esm/icons/search.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import type {
  TribunalStatisticsExclusionReason,
  TribunalStatisticsDistribution,
  TribunalStatisticsItem,
  TribunalStatisticsMetric,
  TribunalStatisticsResponse,
} from "@/lib/tribunal-statistics";
import { TRIBUNAL_STATISTICS_WARNING } from "@/lib/tribunal-statistics";

export type TribunalStatisticsWindowMonths = 12 | 24 | 36;

export const TRIBUNAL_STATISTICS_ACCESS_ERROR_MESSAGE =
  "Impossible de vérifier votre accès Analyse. Réessayez dans quelques instants.";
export const TRIBUNAL_STATISTICS_LOAD_ERROR_MESSAGE =
  "Les statistiques par tribunal sont temporairement indisponibles. Réessayez dans quelques instants.";

type TribunalStatisticsDashboardProps = {
  data?: TribunalStatisticsResponse;
  error?: Error | null;
  isLoading?: boolean;
  windowMonths: TribunalStatisticsWindowMonths;
  onWindowMonthsChange: (value: TribunalStatisticsWindowMonths) => void;
  onRetry?: () => void;
};

type ReliabilityLevel = "insufficient_data" | "smoothed" | "descriptive" | "robust";

type Metric = {
  raw: number | null;
  adjusted: number | null;
  numerator: number | null;
  denominator: number | null;
  n: number | null;
  eligibleUniverse: number | null;
  unknownCount: number | null;
  excludedCount: number | null;
  exclusionReasons: Record<string, number>;
  method: string | null;
  lower: number | null;
  upper: number | null;
};

type Distribution = {
  raw: Quantiles | null;
  adjusted: Quantiles | null;
  n: number | null;
  eligibleUniverse: number | null;
  unknownCount: number | null;
  excludedCount: number | null;
  exclusionReasons: Record<string, number>;
  parentSampleSize: number | null;
  method: string | null;
};

type Quantiles = { p10: number | null; p50: number | null; p90: number | null };

type DashboardItem = {
  code: string;
  name: string;
  scope: "tribunal" | "national";
  reliability: ReliabilityLevel;
  qualityGatePassed: boolean;
  periodStart: string | null;
  periodEnd: string | null;
  generatedAt: string | null;
  eligibleUniverse: number | null;
  verifiedResults: number | null;
  doubleReviewed: number | null;
  unknownCount: number | null;
  coverage: number | null;
  metrics: Record<string, Metric>;
  ratios: Record<string, Distribution>;
  delays: Record<string, Distribution>;
  fallbackLabel: string | null;
  methodology: {
    builderVersion: string | null;
    eligibilityRuleVersion: string | null;
    smoothingRuleVersion: string | null;
  };
  limitations: string[];
  reliabilityWarnings: string[];
};

type DashboardView = {
  tribunals: DashboardItem[];
  national: DashboardItem | null;
  generatedAt: string | null;
  experimental: boolean;
  limitations: string[];
};

const FLOW_METRICS = [
  {
    key: "held",
    label: "Audience tenue",
    detail: "Parmi les issues de déroulement connues.",
  },
  {
    key: "postponed",
    label: "Report",
    detail: "Parmi les issues de déroulement connues.",
  },
  {
    key: "cancelled",
    label: "Annulation",
    detail: "Parmi les issues de déroulement connues.",
  },
  {
    key: "notRequested",
    label: "Vente non requise",
    detail: "Parmi les issues de déroulement connues.",
  },
  {
    key: "noBid",
    label: "Enchères désertes",
    detail: "Uniquement parmi les audiences tenues.",
  },
  {
    key: "adjudicated",
    label: "Adjudication",
    detail: "Uniquement parmi les audiences tenues.",
  },
  {
    key: "surenchere",
    label: "Surenchère déposée",
    detail: "Parmi les fenêtres de surenchère définitivement connues.",
  },
] as const;

const RATIO_METRICS = [
  {
    key: "finalToEffective",
    label: "Prix final / mise effective",
  },
  {
    key: "finalToInitial",
    label: "Prix final / mise initiale",
  },
  {
    key: "finalToMarket",
    label: "Prix final / valeur de marché pré-audience",
  },
] as const;

const DELAY_METRICS = [
  {
    key: "hearingToKnownResult",
    label: "Audience → résultat connu par ImmoJudis",
  },
  {
    key: "postponementToNextHearing",
    label: "Report → nouvelle audience",
  },
] as const;

const WINDOWS: TribunalStatisticsWindowMonths[] = [12, 24, 36];

export function TribunalStatisticsDashboard({
  data,
  error = null,
  isLoading = false,
  windowMonths,
  onWindowMonthsChange,
  onRetry,
}: TribunalStatisticsDashboardProps) {
  const [search, setSearch] = useState("");
  const [selectedCourtCode, setSelectedCourtCode] = useState("");
  const view = useMemo(() => normalizeResponse(data), [data]);
  const normalizedSearch = normalizeSearch(search);
  const filteredTribunals = useMemo(
    () =>
      view.tribunals.filter((item) =>
        normalizeSearch(`${item.name} ${item.code}`).includes(normalizedSearch),
      ),
    [normalizedSearch, view.tribunals],
  );
  const selected =
    filteredTribunals.find((item) => item.code === selectedCourtCode) ??
    filteredTribunals[0] ??
    null;

  return (
    <main className="min-h-screen bg-[#eef7ff] text-brand-navy">
      <header className="border-b border-brand-navy/10 bg-white/72">
        <div className="mx-auto max-w-[1260px] px-4 py-10 sm:px-6 lg:px-8 lg:py-14">
          <h1 className="max-w-4xl font-display text-4xl font-medium leading-tight sm:text-5xl lg:text-6xl">
            Statistiques par tribunal
          </h1>
          <p className="mt-4 max-w-3xl text-sm leading-relaxed text-brand-navy/68 sm:text-base">
            Résultats judiciaires vérifiés, couverture et incertitude sont affichés ensemble. Ces
            observations décrivent un historique : elles ne constituent ni un classement ni une
            garantie sur une audience future.
          </p>
          {view.experimental ? (
            <p className="mt-4 inline-flex items-center gap-2 rounded-md border border-gold/25 bg-[#fffaf2] px-3 py-2 text-xs font-semibold text-brand-navy/72">
              <AlertTriangle className="h-4 w-4 text-gold-soft" aria-hidden />
              Version expérimentale contrôlée · usage descriptif uniquement
            </p>
          ) : null}

          <div className="mt-8 grid gap-4 border-y border-brand-navy/12 py-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-[0.12em] text-brand-navy/60">
                Rechercher un tribunal
              </span>
              <span className="relative mt-2 block max-w-2xl">
                <Search
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-brand-navy/45"
                  aria-hidden
                />
                <Input
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Nom ou code du tribunal"
                  className="h-11 border-brand-navy/15 bg-white pl-10 text-sm text-brand-navy"
                />
              </span>
            </label>

            <fieldset>
              <legend className="text-xs font-semibold uppercase tracking-[0.12em] text-brand-navy/60">
                Période observée
              </legend>
              <div className="mt-2 inline-flex rounded-md border border-brand-navy/15 bg-white p-1">
                {WINDOWS.map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={windowMonths === value}
                    onClick={() => onWindowMonthsChange(value)}
                    className={`min-h-9 rounded px-3 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold ${
                      windowMonths === value
                        ? "bg-brand-navy text-white"
                        : "text-brand-navy/68 hover:bg-brand-navy/5 hover:text-brand-navy"
                    }`}
                  >
                    {value} mois
                  </button>
                ))}
              </div>
            </fieldset>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1260px] px-4 py-8 sm:px-6 lg:px-8 lg:py-12">
        {isLoading ? <DashboardSkeleton /> : null}
        {!isLoading && error ? <DashboardError error={error} onRetry={onRetry} /> : null}
        {!isLoading && !error && !view.tribunals.length ? <DashboardEmpty /> : null}
        {!isLoading && !error && view.tribunals.length && !filteredTribunals.length ? (
          <NoCourtMatch search={search} />
        ) : null}

        {!isLoading && !error && selected ? (
          <>
            <label className="block max-w-2xl">
              <span className="text-xs font-semibold uppercase tracking-[0.12em] text-brand-navy/60">
                Tribunal affiché
              </span>
              <select
                value={selected.code}
                onChange={(event) => setSelectedCourtCode(event.target.value)}
                className="mt-2 h-11 w-full rounded-md border border-brand-navy/15 bg-white px-3 text-sm font-semibold text-brand-navy outline-none focus:border-gold focus:ring-2 focus:ring-gold/20"
              >
                {filteredTribunals.map((item) => (
                  <option key={item.code} value={item.code}>
                    {item.name} · {item.code}
                  </option>
                ))}
              </select>
            </label>

            <TribunalDetail item={selected} />

            {view.national ? (
              <section
                aria-labelledby="national-reference-title"
                className="mt-12 border-y border-gold/25 bg-[#fffaf2] px-4 py-8 sm:px-6 lg:px-8"
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                  <div>
                    <h2
                      id="national-reference-title"
                      className="font-display text-3xl font-semibold sm:text-4xl"
                    >
                      Référence nationale
                    </h2>
                    <p className="mt-2 max-w-2xl text-sm leading-relaxed text-brand-navy/65">
                      Même période et mêmes règles d’éligibilité. Cette référence est présentée
                      séparément et ne forme aucun classement de tribunaux.
                    </p>
                  </div>
                  <ReliabilityLabel level={view.national.reliability} />
                </div>
                <MetricTable item={view.national} compact />
              </section>
            ) : null}

            <MethodAndLimits
              item={selected}
              responseLimitations={view.limitations}
              generatedAt={selected.generatedAt ?? view.generatedAt}
            />
          </>
        ) : null}
      </div>
    </main>
  );
}

function TribunalDetail({ item }: { item: DashboardItem }) {
  return (
    <article className="mt-8" aria-labelledby="tribunal-statistics-title">
      <div className="flex flex-col gap-4 border-b border-brand-navy/14 pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="flex items-center gap-2 text-sm font-semibold text-gold-soft">
            <Landmark className="h-4 w-4" aria-hidden />
            {item.code}
          </p>
          <h2
            id="tribunal-statistics-title"
            className="mt-2 font-display text-3xl font-semibold sm:text-4xl"
          >
            {item.name}
          </h2>
          <p className="mt-2 text-sm text-brand-navy/62">{formatPeriod(item)}</p>
        </div>
        <ReliabilityLabel level={item.reliability} />
      </div>

      {item.qualityGatePassed ? <CoverageRail item={item} /> : null}

      {item.reliability === "insufficient_data" ? (
        <InsufficientData item={item} />
      ) : (
        <>
          <section aria-labelledby="flow-statistics-title" className="mt-10">
            <h3
              id="flow-statistics-title"
              className="font-display text-2xl font-semibold sm:text-3xl"
            >
              Déroulement des audiences
            </h3>
            <p className="mt-2 max-w-3xl text-sm leading-relaxed text-brand-navy/62">
              Chaque taux conserve son propre dénominateur connu. Une issue inconnue n’est jamais
              assimilée à zéro.
            </p>
            <MetricTable item={item} />
          </section>

          <DistributionSection item={item} />
        </>
      )}
    </article>
  );
}

function CoverageRail({ item }: { item: DashboardItem }) {
  const values = [
    {
      icon: Database,
      label: "Audiences matures avec gel admissible",
      value: formatInteger(item.eligibleUniverse),
    },
    {
      icon: ShieldCheck,
      label: "Statuts connus publiables",
      value: formatInteger(item.verifiedResults),
    },
    {
      icon: BarChart3,
      label: "Couverture connue",
      value: formatPercent(item.coverage),
    },
    {
      icon: AlertTriangle,
      label: "Issues encore inconnues",
      value: formatInteger(item.unknownCount),
    },
  ];

  return (
    <dl className="mt-6 grid border-y border-brand-navy/14 sm:grid-cols-2 lg:grid-cols-4">
      {values.map(({ icon: Icon, label, value }) => (
        <div
          key={label}
          className="border-b border-brand-navy/10 px-3 py-5 last:border-b-0 sm:[&:nth-last-child(-n+2)]:border-b-0 lg:border-b-0 lg:border-r lg:last:border-r-0"
        >
          <dt className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-3 text-xs leading-relaxed text-brand-navy/65">
            <Icon className="mt-0.5 h-5 w-5 text-gold-soft" aria-hidden />
            <span>{label}</span>
          </dt>
          <dd className="ml-9 mt-1 font-display text-2xl font-semibold tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function MetricTable({ item, compact = false }: { item: DashboardItem; compact?: boolean }) {
  const rows = FLOW_METRICS.map((definition) => ({
    ...definition,
    metric: item.metrics[definition.key] ?? emptyMetric(),
  }));

  return (
    <div
      className={`${compact ? "mt-6" : "mt-5"} overflow-x-auto rounded-md border border-brand-navy/12 bg-white`}
      role="region"
      aria-label={compact ? "Statistiques nationales" : "Statistiques de déroulement du tribunal"}
      tabIndex={0}
    >
      <table className="w-full min-w-[980px] border-collapse text-left text-sm">
        <thead className="bg-brand-navy text-white">
          <tr>
            <th scope="col" className="px-4 py-3 font-semibold">
              Indicateur
            </th>
            <th scope="col" className="px-4 py-3 text-right font-semibold">
              Observé brut
            </th>
            <th scope="col" className="px-4 py-3 text-right font-semibold">
              Valeur ajustée
            </th>
            <th scope="col" className="px-4 py-3 text-right font-semibold">
              n connu
            </th>
            <th scope="col" className="px-4 py-3 font-semibold">
              Couverture de la métrique
            </th>
            <th scope="col" className="px-4 py-3 font-semibold">
              Incertitude
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-brand-navy/10">
          {rows.map(({ key, label, detail, metric }) => {
            const publishable = item.reliability !== "insufficient_data" && (metric.n ?? 0) >= 10;
            return (
              <tr key={key}>
                <th scope="row" className="px-4 py-3 font-semibold text-brand-navy">
                  {label}
                  <span className="mt-0.5 block text-xs font-normal text-brand-navy/58">
                    {detail}
                  </span>
                </th>
                <td className="px-4 py-3 text-right font-semibold tabular-nums">
                  {publishable ? formatPercent(metric.raw) : "Non publié"}
                </td>
                <td className="px-4 py-3 text-right font-semibold tabular-nums text-gold-soft">
                  {publishable ? (
                    <>
                      {formatPercent(metric.adjusted)}
                      <span className="mt-0.5 block text-[11px] font-normal text-brand-navy/52">
                        {formatMethod(metric.method)}
                      </span>
                    </>
                  ) : (
                    "Non publié"
                  )}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {metric.n == null ? "—" : metric.n < 10 ? "< 10" : formatInteger(metric.n)}
                </td>
                <td className="px-4 py-3 text-xs leading-relaxed text-brand-navy/62">
                  {publishable ? <MetricCoverage metric={metric} /> : suppressionLabel(item)}
                </td>
                <td className="px-4 py-3 text-brand-navy/62">
                  {publishable ? formatInterval(metric.lower, metric.upper, formatPercent) : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function MetricCoverage({ metric }: { metric: Metric }) {
  const rate =
    metric.denominator != null && metric.eligibleUniverse != null && metric.eligibleUniverse > 0
      ? metric.denominator / metric.eligibleUniverse
      : null;
  const reasonSummary = Object.entries(metric.exclusionReasons)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${formatExclusionReason(reason)} : ${formatInteger(count)}`)
    .join(" · ");

  return (
    <span className="grid gap-0.5">
      <span className="font-semibold text-brand-navy">
        {formatPercent(rate)} · univers {formatInteger(metric.eligibleUniverse)}
      </span>
      <span>
        Inconnues : {formatInteger(metric.unknownCount)} · exclues :{" "}
        {formatInteger(metric.excludedCount)}
      </span>
      {reasonSummary ? <span title={reasonSummary}>{reasonSummary}</span> : null}
    </span>
  );
}

function DistributionSection({ item }: { item: DashboardItem }) {
  const ratioRows = RATIO_METRICS.map((definition) => ({
    ...definition,
    distribution: item.ratios[definition.key] ?? emptyDistribution(),
  }));
  const delayRows = DELAY_METRICS.map((definition) => ({
    ...definition,
    distribution: item.delays[definition.key] ?? emptyDistribution(),
  }));

  return (
    <section aria-labelledby="distribution-title" className="mt-10">
      <h3 id="distribution-title" className="font-display text-2xl font-semibold sm:text-3xl">
        Prix et délais observés
      </h3>
      <p className="mt-2 max-w-3xl text-sm leading-relaxed text-brand-navy/62">
        Les médianes et fourchettes ont chacune leur propre échantillon. Le délai de connaissance
        ImmoJudis n’est pas présenté comme un délai de traitement interne du tribunal.
      </p>

      <div
        className="mt-5 overflow-x-auto rounded-md border border-brand-navy/12 bg-white"
        role="region"
        aria-label="Distributions de prix et délais du tribunal"
        tabIndex={0}
      >
        <table className="w-full min-w-[820px] border-collapse text-left text-sm">
          <thead className="bg-brand-navy text-white">
            <tr>
              <th scope="col" className="px-4 py-3 font-semibold">
                Distribution
              </th>
              <th scope="col" className="px-4 py-3 text-right font-semibold">
                Brut P10 / P50 / P90
              </th>
              <th scope="col" className="px-4 py-3 text-right font-semibold">
                Ajusté P10 / P50 / P90
              </th>
              <th scope="col" className="px-4 py-3 text-right font-semibold">
                Base de calcul
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-brand-navy/10">
            {ratioRows.map(({ key, label, distribution }) => (
              <DistributionRow
                key={key}
                label={label}
                distribution={distribution}
                formatter={formatRatio}
                reliability={item.reliability}
              />
            ))}
            {delayRows.map(({ key, label, distribution }) => (
              <DistributionRow
                key={key}
                label={label}
                distribution={distribution}
                formatter={formatDays}
                reliability={item.reliability}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function DistributionRow({
  label,
  distribution,
  formatter,
  reliability,
}: {
  label: string;
  distribution: Distribution;
  formatter: (value: number | null) => string;
  reliability: ReliabilityLevel;
}) {
  const publishable = reliability !== "insufficient_data" && (distribution.n ?? 0) >= 10;
  return (
    <tr>
      <th scope="row" className="px-4 py-3 font-semibold">
        {label}
      </th>
      <td className="px-4 py-3 text-right tabular-nums">
        {publishable ? formatQuantiles(distribution.raw, formatter) : "Non publié"}
      </td>
      <td className="px-4 py-3 text-right font-semibold tabular-nums text-gold-soft">
        {publishable ? (
          <>
            {formatQuantiles(distribution.adjusted, formatter)}
            <span className="mt-0.5 block text-[11px] font-normal text-brand-navy/52">
              {formatMethod(distribution.method)}
            </span>
          </>
        ) : (
          "Non publié"
        )}
      </td>
      <td className="px-4 py-3 text-right tabular-nums">
        {distribution.n == null ? (
          "—"
        ) : distribution.n < 10 ? (
          "< 10"
        ) : (
          <DistributionCoverage distribution={distribution} />
        )}
      </td>
    </tr>
  );
}

function DistributionCoverage({ distribution }: { distribution: Distribution }) {
  const rate =
    distribution.n != null &&
    distribution.eligibleUniverse != null &&
    distribution.eligibleUniverse > 0
      ? distribution.n / distribution.eligibleUniverse
      : null;
  const reasonSummary = Object.entries(distribution.exclusionReasons)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${formatExclusionReason(reason)} : ${formatInteger(count)}`)
    .join(" · ");

  return (
    <span className="grid gap-0.5 text-xs leading-relaxed">
      <span className="font-semibold text-brand-navy">
        {formatInteger(distribution.n)} connu(s) · {formatPercent(rate)}
      </span>
      <span className="text-brand-navy/62">
        {formatInteger(distribution.unknownCount)} inconnu(s) ·{" "}
        {formatInteger(distribution.excludedCount)} exclu(s)
      </span>
      {reasonSummary ? (
        <span className="text-brand-navy/52" title={reasonSummary}>
          {reasonSummary}
        </span>
      ) : null}
    </span>
  );
}

function MethodAndLimits({
  item,
  responseLimitations,
  generatedAt,
}: {
  item: DashboardItem;
  responseLimitations: string[];
  generatedAt: string | null;
}) {
  const limitations = uniqueStrings(
    [...item.limitations, ...responseLimitations].map(displayLimitation),
  );
  return (
    <details className="mt-10 border-t border-brand-navy/14 pt-5 text-sm text-brand-navy/68">
      <summary className="cursor-pointer font-semibold text-brand-navy">
        Méthode, lissage et limites
      </summary>
      <div className="mt-5 grid gap-6 lg:grid-cols-2">
        <dl className="space-y-3">
          <div>
            <dt className="font-semibold text-brand-navy">Dernier calcul</dt>
            <dd className="mt-1">{formatDate(generatedAt)}</dd>
          </div>
          <div>
            <dt className="font-semibold text-brand-navy">Référence d’ajustement</dt>
            <dd className="mt-1">{item.fallbackLabel ?? "Aucun fallback communiqué"}</dd>
          </div>
          <div>
            <dt className="font-semibold text-brand-navy">Résultats doublement revus</dt>
            <dd className="mt-1">{formatInteger(item.doubleReviewed)}</dd>
          </div>
          <div>
            <dt className="font-semibold text-brand-navy">Versions de calcul</dt>
            <dd className="mt-1">
              Builder {item.methodology.builderVersion ?? "—"} · éligibilité{" "}
              {item.methodology.eligibilityRuleVersion ?? "—"} · lissage{" "}
              {item.methodology.smoothingRuleVersion ?? "—"}
            </dd>
          </div>
        </dl>
        <div>
          <h3 className="font-semibold text-brand-navy">Limites publiées</h3>
          {limitations.length ? (
            <ul className="mt-2 list-disc space-y-2 pl-5">
              {limitations.map((limitation) => (
                <li key={limitation}>{limitation}</li>
              ))}
            </ul>
          ) : (
            <p className="mt-2">Aucune limite supplémentaire communiquée.</p>
          )}
        </div>
      </div>
    </details>
  );
}

function displayLimitation(value: string): string {
  if (value === "round_not_frozen_at_cutoff") {
    return "Certaines audiences matures ont été exclues faute de données gelées à temps; leur effectif exact reste réservé au contrôle opérateur.";
  }
  return value;
}

function ReliabilityLabel({ level }: { level: ReliabilityLevel }) {
  const labels: Record<ReliabilityLevel, string> = {
    insufficient_data: "Données insuffisantes",
    smoothed: "Très lissée",
    descriptive: "Confiance moyenne",
    robust: "Potentiellement robuste",
  };
  const classes: Record<ReliabilityLevel, string> = {
    insufficient_data: "border-brand-navy/15 bg-white text-brand-navy/62",
    smoothed: "border-amber-300/50 bg-amber-50 text-amber-900",
    descriptive: "border-sky-300/50 bg-sky-50 text-sky-900",
    robust: "border-emerald-300/50 bg-emerald-50 text-emerald-900",
  };
  return (
    <span
      className={`inline-flex w-fit items-center gap-2 rounded-md border px-3 py-2 text-xs font-semibold ${classes[level]}`}
    >
      <ShieldCheck className="h-4 w-4" aria-hidden />
      Qualité globale : {labels[level]}
    </span>
  );
}

function InsufficientData({ item }: { item: DashboardItem }) {
  const reasons = insufficientDataReasons(item.reliabilityWarnings);
  return (
    <section className="mt-8 border-y border-brand-navy/14 py-8" aria-live="polite">
      <div className="flex max-w-3xl gap-4">
        <AlertTriangle className="mt-0.5 h-6 w-6 shrink-0 text-gold-soft" aria-hidden />
        <div>
          <h3 className="font-display text-2xl font-semibold">Pas de statistique autonome</h3>
          <div className="mt-2 space-y-2 text-sm leading-relaxed text-brand-navy/65">
            {reasons.map((reason) => (
              <p key={reason}>{reason}</p>
            ))}
            <p>
              Les taux et distributions locaux restent masqués afin d’éviter une fausse précision.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

function DashboardSkeleton() {
  return (
    <section aria-label="Chargement des statistiques par tribunal" className="animate-pulse">
      <Skeleton className="h-11 w-full max-w-2xl bg-brand-navy/10" />
      <div className="mt-8 border-y border-brand-navy/10 py-6">
        <Skeleton className="h-9 w-80 max-w-full bg-brand-navy/10" />
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-24 bg-white/75" />
          ))}
        </div>
      </div>
      <Skeleton className="mt-8 h-72 bg-white/75" />
    </section>
  );
}

function DashboardError({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  const publicMessage =
    error.message === TRIBUNAL_STATISTICS_ACCESS_ERROR_MESSAGE
      ? TRIBUNAL_STATISTICS_ACCESS_ERROR_MESSAGE
      : TRIBUNAL_STATISTICS_LOAD_ERROR_MESSAGE;
  return (
    <section
      role="alert"
      className="border-y border-red-200 bg-red-50 px-4 py-8 text-red-900 sm:px-6"
    >
      <h2 className="font-display text-2xl font-semibold">Statistiques indisponibles</h2>
      <p className="mt-2 text-sm">{publicMessage}</p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-5 inline-flex min-h-10 items-center gap-2 rounded-md border border-red-300 bg-white px-4 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
        >
          <RefreshCw className="h-4 w-4" aria-hidden />
          Réessayer
        </button>
      ) : null}
    </section>
  );
}

function DashboardEmpty() {
  return (
    <section className="border-y border-brand-navy/14 py-10 text-center" aria-live="polite">
      <Landmark className="mx-auto h-8 w-8 text-gold-soft" aria-hidden />
      <h2 className="mt-4 font-display text-2xl font-semibold">Données en consolidation</h2>
      <p className="mx-auto mt-2 max-w-2xl text-sm leading-relaxed text-brand-navy/62">
        Aucun instantané tribunal publiable n’est disponible pour cette période. ImmoJudis n’affiche
        pas de valeurs déduites de candidats non revus.
      </p>
    </section>
  );
}

function NoCourtMatch({ search }: { search: string }) {
  return (
    <section className="border-y border-brand-navy/14 py-10 text-center" aria-live="polite">
      <Search className="mx-auto h-8 w-8 text-gold-soft" aria-hidden />
      <h2 className="mt-4 font-display text-2xl font-semibold">Aucun tribunal correspondant</h2>
      <p className="mt-2 text-sm text-brand-navy/62">
        Aucun nom ou code ne correspond à « {search} » dans la période sélectionnée.
      </p>
    </section>
  );
}

function normalizeResponse(data: TribunalStatisticsResponse | undefined): DashboardView {
  if (!data) {
    return {
      tribunals: [],
      national: null,
      generatedAt: null,
      experimental: false,
      limitations: [],
    };
  }

  return {
    tribunals: data.tribunals
      .map(normalizeItem)
      .sort((left, right) => left.name.localeCompare(right.name, "fr")),
    national: normalizeItem(data.national),
    generatedAt: data.meta.generatedAt,
    experimental: data.meta.experimental,
    limitations: uniqueStrings(data.meta.warnings),
  };
}

function normalizeItem(value: TribunalStatisticsItem): DashboardItem {
  return {
    code: value.tribunal?.code ?? "FR",
    name: value.tribunal?.name ?? "France entière",
    scope: value.scope,
    reliability:
      value.reliability.qualityGatePassed === false ? "insufficient_data" : value.reliability.level,
    qualityGatePassed: value.reliability.qualityGatePassed,
    periodStart: value.period.start,
    periodEnd: value.period.end,
    generatedAt: null,
    eligibleUniverse: value.samples.eligibleRounds,
    verifiedResults: value.samples.status,
    doubleReviewed: value.samples.doubleReviewed,
    unknownCount: value.flow.held.unknownCount,
    coverage: value.reliability.coverage,
    metrics: {
      held: normalizeMetric(value.flow.held),
      postponed: normalizeMetric(value.flow.postponed),
      cancelled: normalizeMetric(value.flow.cancelled),
      notRequested: normalizeMetric(value.flow.notRequested),
      noBid: normalizeMetric(value.flow.noBidIfHeld),
      adjudicated: normalizeMetric(value.flow.adjudicatedIfHeld),
      surenchere: normalizeMetric(value.surenchere.filed),
    },
    ratios: {
      finalToEffective: normalizeDistribution(value.priceRatios.finalToEffective),
      finalToInitial: normalizeDistribution(value.priceRatios.finalToInitial),
      finalToMarket: normalizeDistribution(value.priceRatios.finalToMarket),
    },
    delays: {
      hearingToKnownResult: normalizeDistribution(value.delays.hearingToKnownResult),
      postponementToNextHearing: normalizeDistribution(value.delays.postponementToNextHearing),
    },
    fallbackLabel: value.fallback.parentLabel,
    methodology: {
      builderVersion: value.methodology.builderVersion,
      eligibilityRuleVersion: value.methodology.eligibilityRuleVersion,
      smoothingRuleVersion: value.methodology.smoothingRuleVersion,
    },
    limitations: uniqueStrings([...value.limitations, ...value.reliability.warnings]),
    reliabilityWarnings: uniqueStrings(value.reliability.warnings),
  };
}

function normalizeMetric(value: TribunalStatisticsMetric): Metric {
  return {
    raw: value.rawValue,
    adjusted: value.adjustedValue,
    numerator: value.numerator,
    denominator: value.knownDenominator,
    n: value.knownDenominator,
    eligibleUniverse: value.eligibleUniverse,
    unknownCount: value.unknownCount,
    excludedCount: value.excludedCount,
    exclusionReasons: value.exclusionReasons,
    method: value.method,
    lower: value.confidenceInterval?.low ?? null,
    upper: value.confidenceInterval?.high ?? null,
  };
}

function normalizeDistribution(value: TribunalStatisticsDistribution): Distribution {
  return {
    raw: value.raw,
    adjusted: value.adjusted,
    n: value.sampleSize,
    eligibleUniverse: value.eligibleUniverse,
    unknownCount: value.unknownCount,
    excludedCount: value.excludedCount,
    exclusionReasons: value.exclusionReasons,
    parentSampleSize: value.parentSampleSize,
    method: value.method,
  };
}

function emptyMetric(): Metric {
  return {
    raw: null,
    adjusted: null,
    numerator: null,
    denominator: null,
    n: null,
    eligibleUniverse: null,
    unknownCount: null,
    excludedCount: null,
    exclusionReasons: {},
    method: null,
    lower: null,
    upper: null,
  };
}

function emptyDistribution(): Distribution {
  return {
    raw: null,
    adjusted: null,
    n: null,
    eligibleUniverse: null,
    unknownCount: null,
    excludedCount: null,
    exclusionReasons: {},
    parentSampleSize: null,
    method: null,
  };
}

function formatPeriod(item: DashboardItem): string {
  if (!item.periodStart || !item.periodEnd) return "Période exacte non communiquée";
  return `Période du ${formatDate(item.periodStart)} au ${formatDate(item.periodEnd)}`;
}

function formatDate(value: string | null): string {
  if (!value) return "À confirmer";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "À confirmer";
  return new Intl.DateTimeFormat("fr-FR", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/Paris",
  }).format(date);
}

function formatInteger(value: number | null): string {
  return value == null ? "—" : new Intl.NumberFormat("fr-FR").format(value);
}

function formatPercent(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const percentage = Math.abs(value) <= 1 ? value * 100 : value;
  return `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 }).format(percentage)} %`;
}

function formatRatio(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)}×`;
}

function formatDays(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 }).format(value)} j`;
}

function formatInterval(
  lower: number | null,
  upper: number | null,
  formatter: (value: number | null) => string,
): string {
  return lower == null || upper == null ? "—" : `${formatter(lower)} – ${formatter(upper)}`;
}

function formatQuantiles(
  quantiles: Quantiles | null,
  formatter: (value: number | null) => string,
): string {
  return quantiles
    ? `${formatter(quantiles.p10)} / ${formatter(quantiles.p50)} / ${formatter(quantiles.p90)}`
    : "—";
}

function normalizeSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function formatExclusionReason(value: string): string {
  return (
    EXCLUSION_REASON_LABELS[value as TribunalStatisticsExclusionReason] ??
    "Motif d’exclusion non reconnu"
  );
}

const EXCLUSION_REASON_LABELS = {
  no_terminal_outcome_at_cutoff: "Aucun résultat terminal connu à la date de référence",
  ambiguous_terminal_outcome: "Résultat terminal ambigu",
  outcome_status_claim_ineligible: "Statut du résultat non admissible",
  unsupported_outcome_status: "Statut du résultat non pris en charge",
  surenchere_status_claim_ineligible: "Statut de surenchère non admissible",
  initial_starting_price_eur_claim_ineligible: "Mise à prix initiale non admissible",
  effective_starting_price_eur_claim_ineligible: "Mise à prix effective non admissible",
  final_hammer_price_claim_ineligible: "Prix final non admissible",
  finality_status_claim_ineligible: "Caractère définitif non admissible",
  non_positive_price: "Prix nul ou négatif",
  result_observed_at_claim_ineligible: "Date de connaissance du résultat non admissible",
  result_observed_after_cutoff: "Résultat connu après la date de référence",
  result_observed_before_hearing: "Résultat daté avant l’audience",
} satisfies Record<TribunalStatisticsExclusionReason, string>;

function insufficientDataReasons(warnings: string[]): string[] {
  const publishedWarnings = new Set(warnings);
  const reasons: string[] = [];

  if (publishedWarnings.has(TRIBUNAL_STATISTICS_WARNING.SAMPLE_BELOW_10)) {
    reasons.push("Moins de 10 observations admissibles sont disponibles pour ce tribunal.");
  }
  if (publishedWarnings.has(TRIBUNAL_STATISTICS_WARNING.REVIEW_GATE_FAILED)) {
    reasons.push("La double revue indépendante requise n’est pas encore complète.");
  }
  if (publishedWarnings.has(TRIBUNAL_STATISTICS_WARNING.FREEZE_COVERAGE_FAILED)) {
    reasons.push("La couverture des audiences gelées avant la date de référence est insuffisante.");
  }
  if (publishedWarnings.has(TRIBUNAL_STATISTICS_WARNING.NATIONAL_REFERENCE_UNPUBLISHABLE)) {
    reasons.push(
      "La référence nationale compatible n’est pas publiable; les valeurs locales restent donc masquées.",
    );
  }

  return reasons.length
    ? reasons
    : ["Les conditions de publication contrôlée ne sont pas encore toutes réunies."];
}

function formatMethod(value: string | null): string {
  const labels: Record<string, string> = {
    suppressed: "masqué",
    raw: "sans lissage",
    beta_binomial: "lissage bayésien",
    national_fallback: "référence nationale",
    log_shrinkage: "lissage logarithmique",
  };
  return value ? (labels[value] ?? "méthode non reconnue") : "méthode non communiquée";
}

function suppressionLabel(item: DashboardItem): string {
  const qualityGateReason = item.reliabilityWarnings.some(
    (warning) =>
      warning === TRIBUNAL_STATISTICS_WARNING.REVIEW_GATE_FAILED ||
      warning === TRIBUNAL_STATISTICS_WARNING.FREEZE_COVERAGE_FAILED ||
      warning === TRIBUNAL_STATISTICS_WARNING.NATIONAL_REFERENCE_UNPUBLISHABLE,
  );
  if (item.reliability === "insufficient_data" && qualityGateReason) {
    return "Masquée (contrôle qualité)";
  }
  return "Masquée (seuil de publication)";
}
