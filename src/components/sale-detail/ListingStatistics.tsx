"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchAdjudicationPriceStatistics } from "@/lib/adjudication-price-statistics-client";
import type {
  AdjudicationPriceStatisticsResponse,
  AdjudicationPriceStatisticsScope,
} from "@/lib/adjudication-price-statistics";
import { bidBandLabels } from "@/lib/adjudication-distributions";
import { getExampleTribunalStatistics } from "@/lib/example-tribunal-statistics";
import { formatDateTime, formatPrice } from "@/lib/format";
import type { TribunalListingStatisticsResponse } from "@/lib/tribunal-listing-statistics";
import { fetchTribunalListingStatistics } from "@/lib/tribunal-listing-statistics-client";
import type { AuctionSale } from "@/lib/types";
import styles from "./ListingStatistics.module.css";

type ListingHistoryMonths = 3 | 12 | 36;

type OccupationStatus = "vacant" | "occupied" | "rented";

type ListingActivity = TribunalListingStatisticsResponse["activity"];
type ListingMetric = ListingActivity["startingPriceEur"];

type ExampleTribunalStatistics = {
  activity: TribunalListingStatisticsResponse;
  prices: AdjudicationPriceStatisticsResponse | null;
};

export type ListingStatisticsProps = {
  sale: AuctionSale;
  premium?: boolean;
  publicDemo?: boolean;
  propertyTypeVerified?: boolean;
};

const PERIOD_OPTIONS: readonly ListingHistoryMonths[] = [3, 12, 36];
const UPCOMING_LISTINGS_PREVIEW_LIMIT = 8;

const ANCHORS = [
  ["stats-overview", "Vue d’ensemble"],
  ["stats-ventes", "Ventes à venir"],
  ["stats-chiffres", "Chiffres"],
  ["stats-adjudications", "Adjudications"],
  ["stats-calendrier", "Calendrier"],
  ["stats-communes", "Communes"],
  ["stats-avocats", "Avocats"],
  ["stats-methode", "Méthode"],
] as const;

const OCCUPATION_LABELS: Record<OccupationStatus, string> = {
  vacant: "Libre",
  occupied: "Occupé",
  rented: "Loué",
};

function occupationStatusLabel(value: string | null | undefined): string {
  if (!value) return "Occupation à confirmer";
  return OCCUPATION_LABELS[value as OccupationStatus] ?? value;
}

function formatNumber(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(value);
}

function formatDate(value: string | null | undefined, includeYear = true): string {
  if (!value) return "Date à confirmer";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Date à confirmer";
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "long",
    ...(includeYear ? { year: "numeric" as const } : {}),
    timeZone: "Europe/Paris",
  }).format(date);
}

function formatPercent(value: number | null | undefined): string {
  const normalized = normalizeShare(value);
  if (normalized == null) return "—";
  return `${Math.round(normalized)} %`;
}

function normalizeShare(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const percentage = value <= 1 ? value * 100 : value;
  return Math.max(0, Math.min(100, percentage));
}

function formatUnclampedPercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const percentage = value * 100;
  return `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(percentage)} %`;
}

function metricValue(metric: ListingMetric | undefined, minimumSampleSize = 0): number | null {
  return metric?.status === "published" &&
    metric.value != null &&
    metric.sampleSize >= minimumSampleSize
    ? metric.value
    : null;
}

function metricSample(metric: ListingMetric | undefined): number | null {
  return metric?.sampleSize ?? null;
}

function metricFootnote(metric: ListingMetric | undefined, label = "observations") {
  const sampleSize = metricSample(metric);
  return sampleSize == null ? null : `${formatNumber(sampleSize)} ${label}`;
}

function formatMetricPrice(metric: ListingMetric | undefined, minimumSampleSize = 0): string {
  const value = metricValue(metric, minimumSampleSize);
  return value == null ? "—" : formatPrice(value);
}

function formatRatio(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "Données insuffisantes";
  return `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 }).format(value)}×`;
}

function dateSortValue(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function countValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || value === null) return null;
  if ("value" in value && typeof value.value === "number" && Number.isFinite(value.value)) {
    return value.value;
  }
  if (
    "sampleSize" in value &&
    typeof value.sampleSize === "number" &&
    Number.isFinite(value.sampleSize)
  ) {
    return value.sampleSize;
  }
  return null;
}

function formatSources(sources: unknown): string {
  if (Array.isArray(sources)) {
    const labels = sources
      .filter((source): source is string => typeof source === "string")
      .map(humanizeSourceName);
    if (labels.length > 0) return labels.join(" · ");
  }
  return typeof sources === "string" && sources.trim()
    ? humanizeSourceName(sources)
    : "Sources Immojudis";
}

function humanizeSourceName(value: string): string {
  const normalized = value.trim().replaceAll("_", " ").replaceAll("-", " ");
  if (!normalized) return "Source non renseignée";
  return normalized.charAt(0).toLocaleUpperCase("fr-FR") + normalized.slice(1);
}

function labelForBidBand(band: string): string {
  return bidBandLabels[band as keyof typeof bidBandLabels] ?? band;
}

function localScopeFor(
  prices: AdjudicationPriceStatisticsResponse | null | undefined,
  courtCode: string | null | undefined,
): AdjudicationPriceStatisticsScope | null {
  const local = prices?.tribunal;
  const expectedCode = courtCode?.trim().toLocaleLowerCase("fr-FR");
  if (!local || local.scopeType !== "tribunal" || !local.courtCode || !expectedCode) return null;
  return local.courtCode.trim().toLocaleLowerCase("fr-FR") === expectedCode ? local : null;
}

const PROPERTY_TYPE_LABELS: Record<"apartment" | "house" | "other", string> = {
  apartment: "Appartements",
  house: "Maisons",
  other: "Autres biens",
};

function ProgressBar({
  label,
  value,
  count,
  showShare = true,
}: {
  label: string;
  value: number | null | undefined;
  count?: number | null;
  showShare?: boolean;
}) {
  const percentage = showShare ? normalizeShare(value) : null;
  const width = percentage == null ? 0 : Math.max(0, Math.min(100, percentage));
  return (
    <li className={styles.progressItem}>
      <div className={styles.progressHeader}>
        <span>{label}</span>
        <span className={styles.progressValue}>
          {showShare ? formatPercent(value) : "—"}
          {count != null ? ` · ${formatNumber(count)}` : ""}
        </span>
      </div>
      {showShare ? (
        <div
          className={styles.progressTrack}
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percentage ?? 0}
        >
          <span className={styles.progressFill} style={{ width: `${width}%` }} />
        </div>
      ) : null}
    </li>
  );
}

function EmptyData({
  children = "Données insuffisantes sur cette période.",
}: {
  children?: ReactNode;
}) {
  return <p className={styles.emptyData}>{children}</p>;
}

function SectionHeading({
  eyebrow,
  title,
  description,
  titleId,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  titleId?: string;
}) {
  return (
    <header className={styles.sectionHeading}>
      <p className={styles.eyebrow}>{eyebrow}</p>
      <h3 id={titleId} className={styles.sectionTitle}>
        {title}
      </h3>
      {description ? <p className={styles.sectionDescription}>{description}</p> : null}
    </header>
  );
}

function PriceScopeCard({
  scope,
  title,
  local,
}: {
  scope: AdjudicationPriceStatisticsScope;
  title: string;
  local?: boolean;
}) {
  const distribution = scope.distribution?.bidDistribution ?? [];
  return (
    <article className={`${styles.priceCard} ${local ? styles.localPriceCard : ""}`}>
      <div className={styles.cardTopline}>
        <div>
          <p className={styles.cardEyebrow}>{local ? "Périmètre local" : "Repère distinct"}</p>
          <h4 className={styles.cardTitle}>{title}</h4>
        </div>
        <span className={styles.sampleBadge}>{formatNumber(scope.sampleSize)} adjudications</span>
      </div>
      <p className={styles.scopePeriod}>
        Période publiée : {formatDate(scope.periodStart)} → {formatDate(scope.periodEnd)}
      </p>
      <div className={styles.priceMetricGrid}>
        <div>
          <span className={styles.metricLabel}>Mise à prix médiane</span>
          <strong className={styles.metricValue}>
            {formatPrice(scope.metrics.medianStartingPriceEur)}
          </strong>
        </div>
        <div>
          <span className={styles.metricLabel}>Prix d’adjudication médian publié</span>
          <strong className={styles.metricValue}>
            {formatPrice(scope.metrics.medianHammerPriceEur)}
          </strong>
        </div>
        <div>
          <span className={styles.metricLabel}>Ratio publié / mise à prix</span>
          <strong className={styles.metricValue}>
            {formatRatio(scope.metrics.medianHammerToStartingRatio)}
          </strong>
        </div>
      </div>
      {distribution.length > 0 ? (
        <div className={styles.distributionBlock}>
          <div className={styles.distributionHeading}>
            <span>Répartition des adjudications</span>
            <span>{formatNumber(scope.distribution?.sampleSize)} lots</span>
          </div>
          <ul className={styles.progressList}>
            {distribution.map((item) => (
              <ProgressBar
                key={item.band}
                label={labelForBidBand(item.band)}
                value={item.share}
                count={item.count}
              />
            ))}
          </ul>
        </div>
      ) : null}
      <p className={styles.cardNote}>
        {scope.reliability === "limited"
          ? "Lecture descriptive sur un échantillon encore limité."
          : "Lecture descriptive, sans valeur prédictive pour ce bien."}
      </p>
    </article>
  );
}

function PriceSection({
  premium,
  publicDemo,
  prices,
  pricesLoading,
  pricesError,
  localScope,
  nationalScope,
  onRetry,
}: {
  premium: boolean;
  publicDemo: boolean;
  prices: AdjudicationPriceStatisticsResponse | null | undefined;
  pricesLoading: boolean;
  pricesError: Error | null;
  localScope: AdjudicationPriceStatisticsScope | null;
  nationalScope: AdjudicationPriceStatisticsScope | null;
  onRetry: () => void;
}) {
  return (
    <section
      id="stats-adjudications"
      className={styles.section}
      aria-labelledby="stats-adjudications-title"
    >
      <SectionHeading
        eyebrow="04 / Prix d’adjudication"
        title="Prix d’adjudication publiés"
        titleId="stats-adjudications-title"
        description="Résultats publiés par une source tierce, sur leur période propre. Le filtre des annonces ne modifie pas cette période."
      />
      {publicDemo ? (
        <p className={styles.demoNotice} role="note">
          Données fictives de démonstration · aucun prix réel n’est associé à cette annonce.
        </p>
      ) : null}
      {!premium && !publicDemo ? (
        <div className={styles.lockedCard} role="note">
          <p className={styles.cardEyebrow}>Analyse avancée</p>
          <h4 className={styles.cardTitle}>Prix d’adjudication accessibles avec l’offre Analyse</h4>
          <p>
            Débloquez les résultats locaux publiés pour comparer les mises à prix et les prix
            d’adjudication du tribunal rattaché à cette vente.
          </p>
        </div>
      ) : pricesLoading ? (
        <div className={styles.statusCard} role="status" aria-live="polite">
          Chargement des résultats d’adjudication…
        </div>
      ) : pricesError ? (
        <div className={styles.statusCard} role="alert">
          <p>Les résultats d’adjudication n’ont pas pu être chargés.</p>
          <button type="button" className={styles.retryButton} onClick={onRetry}>
            Réessayer : résultats d’adjudication
          </button>
        </div>
      ) : prices ? (
        <div className={styles.priceStack}>
          {localScope ? (
            <PriceScopeCard scope={localScope} title={localScope.label} local />
          ) : (
            <div className={styles.noLocalPriceCard} role="note">
              <p className={styles.cardEyebrow}>Périmètre local</p>
              <h4 className={styles.cardTitle}>Pas d’échantillon local vérifié</h4>
              <p>
                Aucun résultat d’adjudication ne correspond exactement au tribunal rattaché à cette
                vente. Le repère national reste présenté séparément et ne le remplace pas.
              </p>
            </div>
          )}
          {nationalScope ? (
            <details className={styles.nationalDetails}>
              <summary>Voir le repère France entière, séparément</summary>
              <p className={styles.nationalNote}>
                Référence nationale distincte : elle donne un contexte général et ne constitue pas
                la statistique du tribunal.
              </p>
              <PriceScopeCard scope={nationalScope} title="France entière" />
            </details>
          ) : null}
          <p className={styles.methodHint}>
            Source tierce non officielle : résultats publiés par Licitor, agrégés à titre
            descriptif. Aucun résultat ne prédit le prix de ce bien.
          </p>
        </div>
      ) : (
        <div className={styles.statusCard} role="note">
          <p className={styles.cardTitle}>Prix d’adjudication non disponibles</p>
          <p>Le périmètre local ne dispose pas encore d’un échantillon exploitable.</p>
        </div>
      )}
    </section>
  );
}

export function ListingStatistics({
  sale,
  premium = false,
  publicDemo = false,
}: ListingStatisticsProps) {
  const [historyMonths, setHistoryMonths] = useState<ListingHistoryMonths>(3);
  const [showAllUpcoming, setShowAllUpcoming] = useState(false);
  const methodDetailsRef = useRef<HTMLDetailsElement>(null);
  const initialHashHandledRef = useRef(false);
  const demoFixture = useMemo<ExampleTribunalStatistics | null>(() => {
    if (!publicDemo) return null;
    return getExampleTribunalStatistics(sale, historyMonths) ?? null;
  }, [historyMonths, publicDemo, sale]);

  const activityQuery = useQuery<TribunalListingStatisticsResponse>({
    queryKey: ["listing-statistics", sale.id, historyMonths, publicDemo ? "demo" : "live"],
    queryFn: async () => {
      if (publicDemo) {
        if (!demoFixture) throw new Error("La fixture de démonstration est indisponible.");
        return demoFixture.activity;
      }
      const response = await fetchTribunalListingStatistics({
        saleId: sale.id,
        historyMonths,
      });
      return response;
    },
    enabled: Boolean(sale.id),
    retry: false,
    staleTime: 5 * 60_000,
  });

  const priceQuery = useQuery<AdjudicationPriceStatisticsResponse>({
    queryKey: ["listing-statistics-prices", sale.id],
    queryFn: () => fetchAdjudicationPriceStatistics(sale.id),
    enabled: Boolean(sale.id) && premium && !publicDemo && activityQuery.isSuccess,
    retry: false,
    staleTime: 5 * 60_000,
  });

  const activityResponse = activityQuery.data;
  const activity = activityResponse?.activity;
  const prices = publicDemo ? demoFixture?.prices : priceQuery.data;
  const localScope = localScopeFor(prices, activityResponse?.court.code);
  const nationalScope = prices?.national?.scopeType === "national" ? prices.national : null;
  const unresolvedCourt =
    activityQuery.error instanceof Error &&
    activityQuery.error.name === "TribunalCourtUnresolvedError";
  const titleCourt =
    activityResponse?.court.name ??
    (activityQuery.error
      ? "Tribunal judiciaire à confirmer"
      : (sale.tribunal_name ?? sale.tribunal ?? "Tribunal judiciaire"));
  const periodLabel = `${historyMonths} mois`;
  const minimumSampleSize = activityResponse?.meta.minSampleSize ?? 5;
  const publishedLeadValue = metricValue(activity?.publishedToHearingDays, minimumSampleSize);
  const discoveryLeadValue = metricValue(activity?.discoveryToHearingDays, minimumSampleSize);
  const leadUsesDiscovery = publishedLeadValue == null && discoveryLeadValue != null;
  const leadMetric = activity
    ? leadUsesDiscovery
      ? activity.discoveryToHearingDays
      : activity.publishedToHearingDays
    : undefined;
  const overbidDisplayValue =
    activity &&
    countValue(activity.overbidsKnown) === 0 &&
    (countValue(activity.overbidsUnknown) ?? 0) > 0
      ? null
      : metricValue(activity?.overbidCoverage, minimumSampleSize);
  const knownPropertyTypeCount =
    activity?.propertyTypes.reduce((total, item) => total + item.count, 0) ?? 0;
  const unknownPropertyTypeCount = activity
    ? Math.max(0, activity.observedAnnouncements - knownPropertyTypeCount)
    : 0;
  const propertyTypeSharesAvailable = knownPropertyTypeCount >= minimumSampleSize;
  const knownCommuneCount =
    activity?.communes.reduce((total, commune) => total + commune.count, 0) ?? 0;
  const communeSharesAvailable = knownCommuneCount >= minimumSampleSize;
  const knownLawyerCount =
    activity?.lawyers.reduce((total, lawyer) => total + lawyer.count, 0) ?? 0;
  const lawyerSharesAvailable = knownLawyerCount >= minimumSampleSize;
  const upcomingListings = activity?.upcomingListings ?? [];
  const visibleUpcomingListings = showAllUpcoming
    ? upcomingListings
    : upcomingListings.slice(0, UPCOMING_LISTINGS_PREVIEW_LIMIT);
  const remainingUpcomingListings = Math.max(
    0,
    upcomingListings.length - UPCOMING_LISTINGS_PREVIEW_LIMIT,
  );
  const upcomingListIsApiLimited = activity != null && activity.upcomingSales > 100;

  const retryActivity = () => {
    void activityQuery.refetch();
  };

  useEffect(() => {
    if (!activityResponse || initialHashHandledRef.current || typeof window === "undefined") return;
    const targetId = ANCHORS.find(([id]) => window.location.hash === `#${id}`)?.[0];
    if (!targetId) {
      initialHashHandledRef.current = true;
      return;
    }
    initialHashHandledRef.current = true;
    const target = document.getElementById(targetId);
    if (!target) return;
    window.requestAnimationFrame(() => {
      target.scrollIntoView({ block: "start" });
      if (targetId === "stats-methode") methodDetailsRef.current?.setAttribute("open", "");
    });
  }, [activityResponse]);

  useEffect(() => {
    setShowAllUpcoming(false);
  }, [historyMonths]);

  return (
    <section id="stats-overview" className={styles.root} aria-labelledby="listing-statistics-title">
      <header className={styles.hero}>
        <div className={styles.heroTopline}>
          <div>
            <p className={styles.eyebrow}>Statistiques tribunal</p>
            <h2 id="listing-statistics-title" className={styles.heroTitle}>
              {titleCourt}
            </h2>
            <p className={styles.heroDescription}>
              Les ventes immobilières de ce tribunal, leurs audiences et leurs chiffres clés.
              {publicDemo ? " Données fictives de démonstration." : null}
            </p>
            {activityResponse ? (
              <div className={styles.heroMeta} aria-label="Sources et dates des statistiques">
                <span>
                  Annonces recensées : {formatDate(activityResponse.period.historyStart)} →{" "}
                  {formatDate(activityResponse.period.historyEnd)}
                </span>
                {activity ? (
                  <span>
                    {formatNumber(activity.observedAnnouncements)} annonces recensées ·{" "}
                    {formatNumber(countValue(activity.publicationDatesKnown))} dates de publication
                    connues · {formatNumber(countValue(activity.discoveryDatesUsed))} premiers
                    repérages utilisés
                  </span>
                ) : null}
                <span>
                  Mis à jour le {formatDateTime(activityResponse.meta.generatedAt)} · données
                  arrêtées au {formatDateTime(activityResponse.period.asOf)}
                </span>
                <span>Sources : {formatSources(activityResponse.meta.sources)}</span>
              </div>
            ) : null}
          </div>
          <label className={styles.periodControl}>
            <span>Période des annonces</span>
            <select
              aria-label="Période des annonces"
              value={historyMonths}
              onChange={(event) =>
                setHistoryMonths(Number(event.target.value) as ListingHistoryMonths)
              }
            >
              {PERIOD_OPTIONS.map((months) => (
                <option key={months} value={months}>
                  {months} mois
                </option>
              ))}
            </select>
          </label>
        </div>
        <nav className={styles.anchorNav} aria-label="Sections des statistiques">
          {ANCHORS.map(([id, label]) => (
            <a key={id} href={`#${id}`}>
              {label}
            </a>
          ))}
        </nav>
      </header>

      {activityQuery.isPending ? (
        <div className={styles.statusCard} role="status" aria-live="polite">
          Chargement des statistiques du tribunal…
        </div>
      ) : activityQuery.error || !activityResponse || !activity ? (
        <div className={styles.statusCard} role="alert">
          <p className={styles.cardEyebrow}>
            {unresolvedCourt ? "Rattachement à confirmer" : "Statistiques indisponibles"}
          </p>
          <h3 className={styles.cardTitle}>
            {unresolvedCourt
              ? "Le tribunal exact de cette vente n’est pas encore confirmé"
              : "Les statistiques de ce tribunal n’ont pas pu être chargées"}
          </h3>
          <p>
            {unresolvedCourt
              ? "Aucune statistique nationale ou celle d’une autre ville n’est substituée à ce périmètre local."
              : "Vérifiez votre connexion puis relancez le chargement des données."}
          </p>
          <button type="button" className={styles.retryButton} onClick={retryActivity}>
            Réessayer : statistiques du tribunal
          </button>
        </div>
      ) : (
        <div className={styles.content}>
          <section className={styles.section} aria-labelledby="stats-overview-title">
            <div className={styles.sectionHeadingRow}>
              <SectionHeading
                eyebrow="01 / Vue d’ensemble"
                title="Le tribunal en quelques chiffres"
                titleId="stats-overview-title"
                description={`Période des annonces : ${periodLabel}. Les ventes passées et les audiences à venir sont toujours distinguées.`}
              />
              <span className={styles.periodBadge}>
                {activity.observedAnnouncements >= minimumSampleSize
                  ? "Échantillon descriptif"
                  : "Échantillon limité"}
              </span>
            </div>
            <div className={styles.kpiGrid}>
              <article className={styles.kpiCard}>
                <span className={styles.kpiLabel}>Ventes à venir</span>
                <strong className={styles.kpiValue}>{formatNumber(activity.upcomingSales)}</strong>
                <span className={styles.kpiNote}>parmi les annonces recensées</span>
              </article>
              <article className={styles.kpiCard}>
                <span className={styles.kpiLabel}>Prochaine audience</span>
                <strong className={styles.kpiValueSmall}>{formatDate(activity.nextSaleAt)}</strong>
                <span className={styles.kpiNote}>
                  {formatNumber(activity.upcomingSales)} vente(s) à venir
                </span>
              </article>
              <article className={styles.kpiCard}>
                <span className={styles.kpiLabel}>Mise à prix médiane</span>
                <strong className={styles.kpiValueSmall}>
                  {formatMetricPrice(activity.startingPriceEur, minimumSampleSize)}
                </strong>
                <span className={styles.kpiNote}>
                  {metricFootnote(activity.startingPriceEur, "mises à prix renseignées") ??
                    "Échantillon insuffisant"}
                </span>
              </article>
              <article className={styles.kpiCard}>
                <span className={styles.kpiLabel}>Mise à prix / valeur DVF</span>
                <strong className={styles.kpiValueSmall}>
                  {formatUnclampedPercent(
                    metricValue(activity.startingPriceToDvfRatio, minimumSampleSize),
                  )}
                </strong>
                <span className={styles.kpiNote}>
                  {metricFootnote(activity.startingPriceToDvfRatio, "estimations DVF") ??
                    "Échantillon insuffisant"}
                </span>
              </article>
            </div>
          </section>

          <section
            id="stats-ventes"
            className={styles.section}
            aria-labelledby="stats-ventes-title"
          >
            <SectionHeading
              eyebrow="02 / Ventes à venir"
              title="Les prochaines annonces du tribunal"
              titleId="stats-ventes-title"
              description="Les audiences à venir sont affichées séparément, avec leur date, leur mise à prix et les sources visibles."
            />
            {upcomingListings.length > 0 ? (
              <>
                <div id="stats-upcoming-list" className={styles.salesGrid} aria-live="polite">
                  {visibleUpcomingListings.map((listing) => (
                    <article key={listing.id} className={styles.saleItem}>
                      <div className={styles.saleItemTopline}>
                        <span className={styles.saleDate}>{formatDate(listing.saleAt)}</span>
                        {listing.occupationStatus ? (
                          <span className={styles.sampleBadge}>
                            {occupationStatusLabel(listing.occupationStatus)}
                          </span>
                        ) : null}
                      </div>
                      {publicDemo ? (
                        <span className={styles.saleLink}>
                          {listing.title || "Vente immobilière judiciaire"}
                        </span>
                      ) : (
                        <a
                          className={styles.saleLink}
                          href={`/sales/${encodeURIComponent(listing.id)}`}
                        >
                          {listing.title || "Vente immobilière judiciaire"}
                        </a>
                      )}
                      <p className={styles.saleMeta}>
                        {listing.city || "Commune à confirmer"} ·{" "}
                        {formatPrice(listing.startingPriceEur)}
                      </p>
                      <div className={styles.saleEvidence}>
                        <span>{listing.hasVisit ? "Visite renseignée" : "Visite à confirmer"}</span>
                        {listing.sourceNames?.length ? (
                          <span>{listing.sourceNames.map(humanizeSourceName).join(" · ")}</span>
                        ) : null}
                      </div>
                    </article>
                  ))}
                </div>
                {remainingUpcomingListings > 0 || upcomingListIsApiLimited ? (
                  <div className={styles.upcomingControls}>
                    {remainingUpcomingListings > 0 ? (
                      <button
                        type="button"
                        className={styles.upcomingToggle}
                        aria-controls="stats-upcoming-list"
                        aria-expanded={showAllUpcoming}
                        onClick={() => setShowAllUpcoming((expanded) => !expanded)}
                      >
                        {showAllUpcoming
                          ? "Réduire la liste"
                          : "Voir les " +
                            formatNumber(remainingUpcomingListings) +
                            " autres annonces"}
                      </button>
                    ) : null}
                    {upcomingListIsApiLimited ? (
                      <p className={styles.upcomingCount} role="status">
                        {formatNumber(visibleUpcomingListings.length)} affichées sur{" "}
                        {formatNumber(activity.upcomingSales)} annonces recensées. Les détails
                        disponibles sont limités aux 100 premières.
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </>
            ) : (
              <EmptyData>Aucune vente à venir n’est recensée sur cette période.</EmptyData>
            )}
          </section>

          <section
            id="stats-chiffres"
            className={styles.section}
            aria-labelledby="stats-chiffres-title"
          >
            <SectionHeading
              eyebrow="03 / Chiffres du tribunal"
              title="Quel type d’activité se dégage ?"
              titleId="stats-chiffres-title"
              description="Répartition des annonces recensées sur la période sélectionnée, avec les effectifs et les dénominateurs utiles."
            />
            <div className={styles.familyGrid}>
              <article className={styles.familyCard}>
                <div className={styles.cardTopline}>
                  <h4 className={styles.cardTitle}>Types de biens</h4>
                  <span className={styles.sampleBadge}>annonces recensées</span>
                </div>
                <p className={styles.inlineEvidence}>
                  {formatNumber(knownPropertyTypeCount)} annonces avec type renseigné ·{" "}
                  {formatNumber(unknownPropertyTypeCount)} à confirmer
                </p>
                {activity.propertyTypes.length > 0 ? (
                  <>
                    <ul className={styles.progressList}>
                      {activity.propertyTypes.map((item) => (
                        <ProgressBar
                          key={item.propertyType}
                          label={PROPERTY_TYPE_LABELS[item.propertyType]}
                          value={item.share}
                          count={item.count}
                          showShare={propertyTypeSharesAvailable}
                        />
                      ))}
                    </ul>
                    {!propertyTypeSharesAvailable ? (
                      <p className={styles.progressCaption}>
                        Pourcentages masqués sous {minimumSampleSize} types renseignés ; les
                        effectifs restent visibles.
                      </p>
                    ) : null}
                  </>
                ) : (
                  <EmptyData>
                    Aucune répartition de type n’est disponible sur cette période.
                  </EmptyData>
                )}
              </article>
              <article className={styles.familyCard}>
                <div className={styles.cardTopline}>
                  <h4 className={styles.cardTitle}>Occupation</h4>
                  <span className={styles.sampleBadge}>annonces recensées</span>
                </div>
                {activity.occupation ? (
                  <>
                    <p className={styles.inlineEvidence}>
                      {formatNumber(activity.occupation.knownSales)} annonces renseignées ·{" "}
                      {formatNumber(activity.occupation.unknownSales)} à confirmer
                    </p>
                    {activity.occupation.distribution.length > 0 ? (
                      <ul className={styles.progressList}>
                        {activity.occupation.distribution.map((item) => (
                          <ProgressBar
                            key={item.status}
                            label={OCCUPATION_LABELS[item.status]}
                            value={item.share}
                            count={item.count}
                            showShare={activity.occupation.knownSales >= minimumSampleSize}
                          />
                        ))}
                      </ul>
                    ) : (
                      <EmptyData>Aucun statut d’occupation n’est renseigné.</EmptyData>
                    )}
                    {activity.occupation.knownSales < minimumSampleSize &&
                    activity.occupation.distribution.length > 0 ? (
                      <p className={styles.progressCaption}>
                        Moins de {minimumSampleSize} occupations renseignées : effectifs affichés,
                        pourcentages masqués.
                      </p>
                    ) : null}
                  </>
                ) : (
                  <EmptyData>
                    La ventilation de l’occupation n’est pas disponible sur cette période.
                  </EmptyData>
                )}
              </article>
              <article className={styles.familyCard}>
                <div className={styles.cardTopline}>
                  <h4 className={styles.cardTitle}>Déroulement</h4>
                  <span className={styles.sampleBadge}>annonces recensées</span>
                </div>
                <div className={styles.detailMetricList}>
                  <div>
                    <span>Visites renseignées</span>
                    <strong>
                      {formatPercent(metricValue(activity.visitCoverage, minimumSampleSize))}
                    </strong>
                    <small>
                      {metricFootnote(activity.visitCoverage, "annonces") ?? "Donnée indisponible"}
                    </small>
                  </div>
                  <div>
                    <span>Surenchères renseignées</span>
                    <strong>{formatPercent(overbidDisplayValue)}</strong>
                    <small>
                      {formatNumber(activity.overbidsKnown)} connues sur{" "}
                      {formatNumber(activity.overbidsKnown + activity.overbidsUnknown)} annonces ·{" "}
                      {formatNumber(activity.overbidsUnknown)} à confirmer
                    </small>
                  </div>
                  <div>
                    <span>
                      {leadUsesDiscovery ? "Premier repérage → audience" : "Publication → audience"}
                    </span>
                    <strong>
                      {metricValue(leadMetric, minimumSampleSize) == null
                        ? "—"
                        : `${formatNumber(metricValue(leadMetric, minimumSampleSize))} jours`}
                    </strong>
                    <small>
                      {metricFootnote(
                        leadMetric,
                        leadUsesDiscovery ? "dates de première détection" : "dates de publication",
                      ) ?? "Échantillon insuffisant"}
                    </small>
                  </div>
                </div>
              </article>
            </div>
          </section>

          <PriceSection
            premium={premium}
            publicDemo={publicDemo}
            prices={prices}
            pricesLoading={priceQuery.isPending && premium && !publicDemo}
            pricesError={priceQuery.error instanceof Error ? priceQuery.error : null}
            localScope={localScope}
            nationalScope={nationalScope}
            onRetry={() => {
              void priceQuery.refetch();
            }}
          />

          <section
            id="stats-calendrier"
            className={styles.section}
            aria-labelledby="stats-calendrier-title"
          >
            <SectionHeading
              eyebrow="05 / Calendrier"
              title="Les prochaines audiences"
              titleId="stats-calendrier-title"
              description="Calendrier des ventes à venir sur les 90 prochains jours, rattaché au tribunal local."
            />
            {activity.hearingCalendar?.length ? (
              <div className={styles.calendarGrid}>
                {[...activity.hearingCalendar]
                  .sort((left, right) => dateSortValue(left.date) - dateSortValue(right.date))
                  .map((hearing) => {
                    const maxSales = Math.max(
                      ...activity.hearingCalendar!.map((item) => item.sales),
                      1,
                    );
                    const share = (hearing.sales / maxSales) * 100;
                    return (
                      <article key={hearing.date} className={styles.calendarItem}>
                        <div className={styles.calendarDate}>{formatDate(hearing.date)}</div>
                        <strong>{formatNumber(hearing.sales)} vente(s)</strong>
                        <div className={styles.progressTrack} aria-hidden="true">
                          <span className={styles.progressFill} style={{ width: `${share}%` }} />
                        </div>
                      </article>
                    );
                  })}
              </div>
            ) : (
              <EmptyData>
                Aucune audience détaillée n’est disponible sur les 90 prochains jours.
              </EmptyData>
            )}
          </section>

          <section
            id="stats-communes"
            className={styles.section}
            aria-labelledby="stats-communes-title"
          >
            <SectionHeading
              eyebrow="06 / Communes"
              title="Les communes représentées"
              titleId="stats-communes-title"
              description="Communes présentes dans les annonces recensées. Ce relevé ne décrit pas l’ensemble du ressort du tribunal."
            />
            {activity.communes?.length ? (
              <div className={styles.communesGrid}>
                {[...activity.communes]
                  .sort(
                    (left, right) =>
                      right.count - left.count || left.city.localeCompare(right.city),
                  )
                  .map((commune) => (
                    <article key={commune.city} className={styles.communeItem}>
                      <div className={styles.progressHeader}>
                        <span>{commune.city}</span>
                        <span className={styles.progressValue}>
                          {formatNumber(commune.count)} ·{" "}
                          {communeSharesAvailable ? formatPercent(commune.share) : "—"}
                        </span>
                      </div>
                      {communeSharesAvailable ? (
                        <div
                          className={styles.progressTrack}
                          role="progressbar"
                          aria-label={commune.city}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={normalizeShare(commune.share) ?? 0}
                        >
                          <span
                            className={styles.progressFill}
                            style={{ width: `${normalizeShare(commune.share) ?? 0}%` }}
                          />
                        </div>
                      ) : null}
                    </article>
                  ))}
              </div>
            ) : (
              <EmptyData>Aucune commune n’est renseignée sur cette période.</EmptyData>
            )}
            {activity.communes?.length > 0 && !communeSharesAvailable ? (
              <p className={styles.progressCaption}>
                Pourcentages masqués sous {minimumSampleSize} communes renseignées ; les effectifs
                restent visibles.
              </p>
            ) : null}
          </section>

          <section
            id="stats-avocats"
            className={styles.section}
            aria-labelledby="stats-avocats-title"
          >
            <SectionHeading
              eyebrow="07 / Avocats"
              title="Les cabinets présents sur les annonces"
              titleId="stats-avocats-title"
              description="Répartition des cabinets apparaissant sur les annonces recensées pendant la période sélectionnée."
            />
            {activity.lawyers.length > 0 ? (
              <>
                <div
                  className={styles.lawyerTable}
                  role="table"
                  aria-label="Cabinets présents sur les annonces"
                >
                  <div className={styles.lawyerRowHeader} role="row">
                    <span role="columnheader">Cabinet</span>
                    <span role="columnheader">Annonces</span>
                    <span role="columnheader">Part</span>
                  </div>
                  {activity.lawyers.map((lawyer) => (
                    <div className={styles.lawyerRow} role="row" key={lawyer.name}>
                      <span role="cell">
                        {lawyer.name ? humanizeSourceName(lawyer.name) : "Cabinet non renseigné"}
                      </span>
                      <span role="cell">{formatNumber(lawyer.count)}</span>
                      <span role="cell">
                        {lawyerSharesAvailable ? formatPercent(lawyer.share) : "—"}
                      </span>
                    </div>
                  ))}
                </div>
                <p className={styles.progressCaption}>
                  Part des annonces où l’avocat est renseigné.
                  {!lawyerSharesAvailable
                    ? " Pourcentages masqués sous le seuil minimal ; les effectifs restent visibles."
                    : null}
                </p>
              </>
            ) : (
              <EmptyData>Aucun cabinet n’est renseigné sur cette période.</EmptyData>
            )}
          </section>

          <section
            id="stats-methode"
            className={styles.section}
            aria-labelledby="stats-methode-title"
          >
            <details ref={methodDetailsRef} className={styles.methodDetails}>
              <summary id="stats-methode-title">Sources et méthode</summary>
              <div className={styles.methodBody}>
                <p>
                  Les chiffres d’activité proviennent des ventes vérifiées ou recoupées par
                  Immojudis, rattachées au tribunal confirmé pour cette annonce. La période récente
                  regroupe les annonces passées et les audiences à venir, en conservant leurs
                  statuts respectifs.
                </p>
                <p>
                  Les avis sont regroupés lorsqu’un identifiant commun, un lien entre sources ou une
                  adresse précise établit qu’ils portent sur le même lot. Les avis dont l’identité
                  reste incertaine demeurent séparés.
                </p>
                <p>
                  Période sélectionnée : <strong>{periodLabel}</strong>, du{" "}
                  {formatDate(activityResponse.period.historyStart)} au{" "}
                  {formatDate(activityResponse.period.historyEnd)}. Les indicateurs masqués
                  signalent un échantillon trop court ; aucune donnée d’un autre tribunal n’est
                  utilisée pour compléter le périmètre local.
                </p>
                <p>
                  Le délai « publication → audience » utilise uniquement les annonces dont la date
                  de publication est connue. Lorsqu’elle manque, le délai « premier repérage →
                  audience » est affiché avec son libellé propre. Les répartitions d’activité sont
                  masquées sous {minimumSampleSize} observations, et les prix d’adjudication sous
                  dix résultats.
                </p>
                <p>
                  La répartition des types de biens utilise les{" "}
                  <strong>{formatNumber(knownPropertyTypeCount)} annonces</strong> dont le type est
                  renseigné ; <strong>{formatNumber(unknownPropertyTypeCount)} annonces</strong>{" "}
                  restent sans catégorie et ne sont pas redistribuées artificiellement.
                </p>
                <p>
                  Les prix d’adjudication publiés, lorsqu’ils sont accessibles, proviennent d’une
                  source tierce non officielle et sont présentés à titre descriptif. La ventilation
                  des communes est un relevé d’activité locale, et non un référentiel administratif
                  officiel.{" "}
                  {publicDemo
                    ? "Cette vue de démonstration utilise des données fictives explicites."
                    : "Les statistiques ne constituent pas une estimation du bien."}
                </p>
                <p>
                  Sources utilisées :{" "}
                  <strong>{formatSources(activityResponse.meta.sources)}</strong>.
                </p>
              </div>
            </details>
          </section>
        </div>
      )}
    </section>
  );
}
