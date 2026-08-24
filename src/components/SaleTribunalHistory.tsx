"use client";

import { useQuery } from "@tanstack/react-query";
import ArrowUpRight from "lucide-react/dist/esm/icons/arrow-up-right.js";
import BarChart3 from "lucide-react/dist/esm/icons/bar-chart-3.js";
import CalendarDays from "lucide-react/dist/esm/icons/calendar-days.js";
import CircleAlert from "lucide-react/dist/esm/icons/circle-alert.js";
import Landmark from "lucide-react/dist/esm/icons/landmark.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchTribunalJudicialActivity } from "@/lib/tribunal-judicial-activity-client";
import type {
  TribunalJudicialActivityMetric,
  TribunalJudicialActivityRangeMetric,
  TribunalJudicialActivityResponse,
} from "@/lib/tribunal-judicial-activity";
import type { AuctionSale } from "@/lib/types";

export function SaleTribunalHistory({ sale }: { sale: AuctionSale }) {
  const courtCode = sale.tribunal_code?.trim() ?? "";
  const courtLabel = sale.tribunal_name?.trim() || sale.tribunal?.trim() || null;
  const query = useQuery({
    queryKey: ["tribunal-judicial-activity", courtCode || sale.id, 36],
    queryFn: () =>
      fetchTribunalJudicialActivity(
        courtCode ? { courtCode, historyMonths: 36 } : { saleId: sale.id, historyMonths: 36 },
      ),
    enabled: Boolean(courtCode || sale.id),
    retry: false,
    staleTime: 5 * 60_000,
  });

  if (query.isLoading) return <HistorySkeleton />;
  if (query.isError || !query.data) {
    return (
      <HistoryNotice
        title={
          courtLabel
            ? `Statistiques de ${courtLabel} en cours de consolidation`
            : "Rattachement exact au tribunal en cours"
        }
        detail="Ce bloc reste présent sur la vente. Immojudis publiera les chiffres dès que le rattachement au référentiel officiel et l’échantillon du même tribunal auront été contrôlés ; aucune statistique approximative n’est substituée."
      />
    );
  }

  return <JudicialActivity activity={query.data} sale={sale} />;
}

function JudicialActivity({
  activity,
  sale,
}: {
  activity: TribunalJudicialActivityResponse;
  sale: AuctionSale;
}) {
  const { court, period, reliability } = activity;
  const metrics = activity.activity;
  const dominantPropertyType = metrics.topPropertyTypes[0];
  const insufficient = reliability.level === "insufficient_data";
  const propertyBenchmark = sale.property_type
    ? metrics.propertyTypeBenchmarks.find(
        (benchmark) => benchmark.propertyType === sale.property_type,
      )
    : null;
  const priceRange = publishedRangeOrFallback(
    propertyBenchmark?.startingPriceRangeEur,
    metrics.startingPriceRangeEur,
  );
  const leadRange = publishedRangeOrFallback(
    propertyBenchmark?.discoveryLeadRangeDays,
    metrics.discoveryLeadRangeDays,
  );
  const benchmarkScope =
    propertyBenchmark && priceRange === propertyBenchmark.startingPriceRangeEur
      ? propertyTypeLabel(propertyBenchmark.propertyType).toLocaleLowerCase("fr-FR")
      : "tous biens confondus";
  const priceComparison = startingPriceComparison(
    sale.starting_price_eur,
    priceRange,
    benchmarkScope,
  );

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
              Ventes judiciaires rattachées à l’adresse du bien
            </p>
            <h2
              id="tribunal-history-title"
              className="mt-2 font-display text-4xl font-medium text-brand-navy sm:text-5xl"
            >
              {court.name}
            </h2>
            <p className="mt-3 max-w-3xl text-sm leading-relaxed text-brand-navy/65 sm:text-base">
              Activité des annonces judiciaires suivies et contrôlées par Immojudis. Les ventes
              notariales, les rattachements incertains et les annonces en conflit sont exclus.
            </p>
          </div>
          <ReliabilityBadge level={reliability.level} label={reliability.label} />
        </div>

        {insufficient ? (
          <div className="mt-7 flex gap-3 border-y border-amber-200 bg-amber-50 px-4 py-5 text-amber-950">
            <CircleAlert className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
            <div>
              <p className="font-semibold">Échantillon local encore limité</p>
              <p className="mt-1 text-sm leading-relaxed">
                Le nombre d’annonces observées reste visible, mais les médianes sont masquées sous
                cinq observations afin d’éviter une fausse précision.
              </p>
            </div>
          </div>
        ) : null}

        {priceComparison ? (
          <div className="mt-7 border-l-4 border-gold-soft bg-[#fffaf2] px-4 py-4">
            <p className="text-sm font-semibold text-brand-navy">{priceComparison}</p>
            <p className="mt-1 text-xs leading-relaxed text-brand-navy/58">
              Positionnement de la mise initiale uniquement : ce repère n’est ni une estimation de
              valeur, ni un conseil ou plafond d’enchère.
            </p>
          </div>
        ) : null}

        <dl className="mt-8 grid overflow-hidden rounded-lg border border-brand-navy/12 bg-[#f8fbfe] sm:grid-cols-2 lg:grid-cols-4">
          <HistoryMetric
            label="Ventes à venir suivies"
            value={String(metrics.upcomingSales)}
            detail={`${metrics.upcomingSales90Days} dans les 90 prochains jours`}
          />
          <HistoryMetric
            label="Mise à prix médiane"
            value={formatRangeMedianCurrency(priceRange)}
            detail={formatRangeCurrency(priceRange, benchmarkScope)}
            accent
          />
          <HistoryMetric
            label="Anticipation observée"
            value={formatRangeMedianDays(leadRange)}
            detail={formatRangeDays(leadRange)}
          />
          <HistoryMetric
            label="Visite annoncée"
            value={formatPercentMetric(metrics.visitCoverage)}
            detail={sampleLabel(metrics.visitCoverage, "annonce")}
          />
        </dl>

        <dl className="mt-7 grid gap-4 border-y border-brand-navy/10 py-5 sm:grid-cols-2 xl:grid-cols-5">
          <ActivityFact
            icon={CalendarDays}
            label="Prochaine audience suivie"
            value={formatDate(metrics.nextSaleAt)}
          />
          <ActivityFact
            icon={BarChart3}
            label="Jours d’audience à venir"
            value={String(metrics.upcomingHearingDays)}
          />
          <ActivityFact
            icon={Landmark}
            label="Lots médians par jour d’audience"
            value={formatNumberMetric(metrics.medianLotsPerHearingDay)}
          />
          <ActivityFact
            icon={CalendarDays}
            label="Intervalle médian entre audiences"
            value={formatCadenceMetric(metrics.medianDaysBetweenHearingDays)}
          />
          <ActivityFact
            icon={ShieldCheck}
            label="Type de bien le plus suivi"
            value={
              dominantPropertyType
                ? `${propertyTypeLabel(dominantPropertyType.propertyType)} · ${formatPercent(dominantPropertyType.share)}`
                : "Non publié"
            }
          />
        </dl>

        <div className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
          <div className="text-xs leading-relaxed text-brand-navy/58">
            <p>
              {metrics.observedPastSales} vente{metrics.observedPastSales > 1 ? "s" : ""} passée
              {metrics.observedPastSales > 1 ? "s" : ""} suivie
              {metrics.observedPastSales > 1 ? "s" : ""} depuis le {formatDate(period.historyStart)}
              . Ce comptage mesure la couverture Immojudis, pas l’activité exhaustive du greffe.
            </p>
            <p className="mt-2 font-semibold text-brand-navy/68">
              Les taux d’adjudication, de surenchère et les hausses de prix final restent masqués
              tant que les résultats judiciaires contrôlés sont insuffisants.
            </p>
          </div>
          <a
            href="/tribunaux"
            className="inline-flex min-h-10 shrink-0 items-center gap-2 text-xs font-semibold text-gold-soft hover:text-gold"
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

function ActivityFact({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Landmark;
  label: string;
  value: string;
}) {
  return (
    <div className="flex gap-3">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-gold-soft" aria-hidden />
      <div>
        <dt className="text-xs text-brand-navy/55">{label}</dt>
        <dd className="mt-1 text-sm font-semibold text-brand-navy">{value}</dd>
      </div>
    </div>
  );
}

function ReliabilityBadge({ level, label }: { level: string; label: string }) {
  const classes =
    level === "strong"
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
      aria-label="Chargement de l’activité judiciaire du tribunal"
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

function sampleLabel(metric: TribunalJudicialActivityMetric, noun: string): string {
  const count = metric.sampleSize;
  return `${count} ${noun}${count > 1 ? "s" : ""} retenue${count > 1 ? "s" : ""}`;
}

function formatPercentMetric(metric: TribunalJudicialActivityMetric): string {
  return metric.status === "published" ? formatPercent(metric.value) : "Non publié";
}

function formatNumberMetric(metric: TribunalJudicialActivityMetric): string {
  if (metric.status !== "published") return "Non publié";
  return new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 }).format(metric.value);
}

function formatCadenceMetric(metric: TribunalJudicialActivityMetric): string {
  if (metric.status !== "published") return "Non publié";
  return `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(metric.value)} jours`;
}

function publishedRangeOrFallback(
  candidate: TribunalJudicialActivityRangeMetric | undefined,
  fallback: TribunalJudicialActivityRangeMetric,
): TribunalJudicialActivityRangeMetric {
  return candidate?.status === "published" ? candidate : fallback;
}

function formatRangeMedianCurrency(metric: TribunalJudicialActivityRangeMetric): string {
  if (metric.status !== "published") return "Non publié";
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  }).format(metric.p50);
}

function formatRangeCurrency(metric: TribunalJudicialActivityRangeMetric, scope: string): string {
  if (metric.status !== "published") return `${metric.sampleSize} annonces retenues`;
  return `50 % entre ${formatCurrencyValue(metric.p25)} et ${formatCurrencyValue(metric.p75)} · ${scope}`;
}

function formatRangeMedianDays(metric: TribunalJudicialActivityRangeMetric): string {
  if (metric.status !== "published") return "Non publié";
  return `${formatNumberValue(metric.p50)} jours`;
}

function formatRangeDays(metric: TribunalJudicialActivityRangeMetric): string {
  if (metric.status !== "published") return `${metric.sampleSize} délais retenus`;
  return `50 % entre ${formatNumberValue(metric.p25)} et ${formatNumberValue(metric.p75)} jours`;
}

function startingPriceComparison(
  startingPriceEur: number | null,
  metric: TribunalJudicialActivityRangeMetric,
  scope: string,
): string | null {
  if (startingPriceEur == null || startingPriceEur <= 0 || metric.status !== "published") {
    return null;
  }
  const difference = (startingPriceEur / metric.p50 - 1) * 100;
  const formattedPrice = formatCurrencyValue(startingPriceEur);
  if (Math.abs(difference) < 1) {
    return `Cette mise à prix de ${formattedPrice} est proche de la médiane du tribunal (${scope}).`;
  }
  return `Cette mise à prix de ${formattedPrice} se situe ${formatNumberValue(Math.abs(difference))} % ${difference < 0 ? "sous" : "au-dessus de"} la médiane du tribunal (${scope}).`;
}

function formatCurrencyValue(value: number): string {
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatNumberValue(value: number): string {
  return new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(value);
}

function formatPercent(value: number): string {
  return new Intl.NumberFormat("fr-FR", {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatDate(value: string | null): string {
  if (!value) return "Aucune date publiée";
  return new Intl.DateTimeFormat("fr-FR", {
    dateStyle: "long",
    timeZone: "Europe/Paris",
  }).format(new Date(value));
}

function propertyTypeLabel(value: string): string {
  return (
    {
      apartment: "Appartement",
      house: "Maison",
      commercial: "Local commercial",
      building: "Immeuble",
      land: "Terrain",
      parking: "Stationnement",
      mixed: "Bien mixte",
      other: "Autre",
    }[value] ?? value
  );
}
