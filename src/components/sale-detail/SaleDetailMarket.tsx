"use client";

import type { ReactNode } from "react";
import dynamic from "next/dynamic";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right.js";
import BadgeEuro from "lucide-react/dist/esm/icons/badge-euro.js";
import ChartNoAxesCombined from "lucide-react/dist/esm/icons/chart-no-axes-combined.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import { useOutcomeGraphForecast } from "@/hooks/use-outcome-graph-forecast";
import panelStyles from "@/components/sale-detail/SaleDetailPanels.module.css";
import { formatDate, formatPrice, formatPricePerM2 } from "@/lib/format";
import type { MarketEstimate } from "@/lib/market.server";
import { marketReferenceConfidence } from "@/lib/market-comparables-analysis";
import {
  computeRecommendedCeilings,
  computeAcquisitionCosts,
  type MarketCeilingResult,
} from "@/lib/profitability";
import type { AuctionSale } from "@/lib/types";

const OutcomeForecast = dynamic(() =>
  import("@/components/OutcomeForecast").then((module) => module.OutcomeForecast),
);

export function TribunalEstimationEvidence({
  sale,
  valuationConflict,
  open,
  onOpenChange,
}: {
  sale: AuctionSale;
  valuationConflict: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const forecastQuery = useOutcomeGraphForecast(sale.id, open && !valuationConflict);
  const forecastReady = !valuationConflict && forecastQuery.data?.forecast.status === "ready";
  return (
    <details id="tribunal-perspective" className={panelStyles.disclosure} open={open}>
      <summary
        onClick={(event) => {
          event.preventDefault();
          onOpenChange(!open);
        }}
      >
        Perspective d’adjudication
      </summary>
      {forecastReady ? <OutcomeForecast forecastQuery={forecastQuery} /> : null}
      <p className="text-sm text-muted-foreground">
        Les observations du tribunal sont disponibles dans l’onglet{" "}
        <a href="#statistiques" className="font-semibold underline underline-offset-4">
          Statistiques
        </a>
        .
      </p>
    </details>
  );
}

type Recommendations = ReturnType<typeof computeRecommendedCeilings>;

export function CeilingExplanation({
  recommendations,
  surface,
  resultOverride,
  worksOverride,
}: {
  recommendations: Recommendations;
  surface: number | null;
  resultOverride?: MarketCeilingResult;
  worksOverride?: number;
}) {
  const result = resultOverride ?? recommendations.withoutWorks;
  const works = worksOverride ?? 0;
  const ceilingCosts = computeAcquisitionCosts({
    price: result.maxBid,
    works,
    fpt: result.simulated.fpt,
    lawyerFees: result.simulated.lawyerFees,
    registrationRate: result.simulated.registrationRate,
    taxRegime: result.simulated.taxRegime,
  });
  const marketBase = result.available
    ? Math.round(result.marketReferencePricePerM2 * Math.max(0, surface ?? 0))
    : null;
  const safetyMargin =
    marketBase != null ? Math.round(marketBase * (result.safetyDiscountPct / 100)) : null;
  const rows = [
    ["Référence de marché du scénario", marketBase],
    ["Marge de sécurité", safetyMargin == null ? null : -safetyMargin],
    ...(result.available && result.occupancy?.applied
      ? ([
          [
            result.occupancy.status === "unknown"
              ? "Décote d’occupation (occupation non confirmée)"
              : "Décote d’occupation",
            -result.occupancy.discountAmount,
          ],
          ...(result.occupancy.carryingCost > 0
            ? ([["Portage avant libération", -result.occupancy.carryingCost]] as const)
            : []),
        ] as const)
      : []),
    [
      "Frais estimés au plafond",
      result.available ? -Math.round(ceilingCosts.acquisitionFeesTotal) : null,
    ],
    ["Travaux inclus", -works],
  ] as const;

  return (
    <div id="why-this-ceiling" className="min-w-0 scroll-mt-36 lg:pr-10">
      <h2 className="font-display text-4xl font-medium text-brand-navy sm:text-5xl">
        Pourquoi {result.available ? formatPrice(result.maxBid) : "ce plafond"} ?
      </h2>
      <dl className="mt-7 border-y border-brand-navy/18">
        {rows.map(([label, value]) => (
          <div
            key={label}
            className="flex items-baseline justify-between gap-4 border-b border-brand-navy/12 py-3.5 last:border-b-0"
          >
            <dt className="text-sm font-medium text-brand-navy sm:text-base">{label}</dt>
            <dd
              className={`font-display text-xl font-semibold sm:text-2xl ${
                value != null && value < 0 ? "text-gold-text" : "text-brand-navy"
              }`}
            >
              {value == null ? "À compléter" : signedPrice(value)}
            </dd>
          </div>
        ))}
        <div className="flex items-baseline justify-between gap-4 border-t border-brand-navy/50 py-5">
          <dt className="font-display text-2xl font-semibold text-brand-navy">
            Enchère plafond selon vos hypothèses
          </dt>
          <dd className="font-display text-3xl font-semibold text-brand-navy sm:text-4xl">
            {result.available ? formatPrice(result.maxBid) : "À compléter"}
          </dd>
        </div>
      </dl>
      <p className="mt-6 max-w-2xl text-sm leading-relaxed text-brand-navy/70 sm:text-base">
        Calcul selon les hypothèses du simulateur. Les frais sont estimés à l’enchère plafond ; les
        arrondis peuvent produire un léger écart avec le total affiché.
      </p>
    </div>
  );
}

function signedPrice(value: number) {
  if (value < 0) return `− ${formatPrice(Math.abs(value))}`;
  return formatPrice(value);
}

export function MarketSnapshot({
  estimate,
  loading,
  computedAt,
}: {
  estimate: MarketEstimate | null;
  loading: boolean;
  computedAt: string | null;
}) {
  const confidence = marketReferenceConfidence(estimate);
  const hasRange =
    estimate?.actionable &&
    estimate.estimatedValueLowEur != null &&
    estimate.estimatedValueHighEur != null;
  const history = estimate?.comparableMode === "address_history";
  const aggregate = estimate?.comparableMode === "geographic_aggregate";
  const count = history ? estimate.addressHistory.length : (estimate?.sampleSize ?? 0);
  return (
    <section className={panelStyles.marketSnapshot} aria-label="Repères de marché">
      <div>
        <span className={panelStyles.metricEyebrow}>Fourchette de marché</span>
        <strong>
          {hasRange
            ? `${formatPrice(estimate.estimatedValueLowEur!)} – ${formatPrice(estimate.estimatedValueHighEur!)}`
            : loading
              ? "Calcul en cours…"
              : "Références à compléter"}
        </strong>
        <p>
          {estimate?.source ?? "DVF"}
          {computedAt
            ? ` · Actualisée le ${formatDate(computedAt)}`
            : " · Date de calcul non renseignée"}
        </p>
      </div>
      <div>
        <span className={panelStyles.metricEyebrow}>Solidité des données</span>
        <strong className={panelStyles.confidenceText}>{confidence.confidenceLabel}</strong>
        <p>
          {count}{" "}
          {history
            ? "vente(s) à cette adresse"
            : aggregate
              ? "vente(s) de référence"
              : "vente(s) comparable(s)"}
          {estimate
            ? ` · ${aggregate ? `Échelle ${aggregateScopeLabel(estimate.geographyLevel)}` : history ? "Lots potentiellement différents" : `Rayon ${estimate.radiusM} m`}`
            : ""}
        </p>
      </div>
      <a href="#market">
        Examiner les références <ArrowRight className="h-4 w-4" aria-hidden />
      </a>
    </section>
  );
}

export function MarketEvidence({
  marketEstimate,
  marketLoading,
}: {
  marketEstimate: MarketEstimate | null;
  marketLoading: boolean;
}) {
  const usesAddressHistory = marketEstimate?.comparableMode === "address_history";
  const comparables = usesAddressHistory
    ? (marketEstimate?.addressHistory ?? []).map((sale) => ({
        ...sale,
        distanceM: null,
        unitCount: null,
      }))
    : (marketEstimate?.recentTransactions ?? []);
  const usesAggregateStatistics = marketEstimate?.comparableMode === "geographic_aggregate";
  const usesParkingSales = marketEstimate?.comparableMode === "unit_sales";
  const sampleCount = usesAddressHistory
    ? (marketEstimate?.addressHistory.length ?? 0)
    : (marketEstimate?.sampleSize ?? 0);
  const sampleLabel = !marketEstimate
    ? "Échantillon indisponible"
    : usesAddressHistory
      ? `${sampleCount} vente${sampleCount > 1 ? "s" : ""} à cette adresse`
      : usesParkingSales
        ? `${sampleCount} vente${sampleCount > 1 ? "s" : ""} de stationnement`
        : usesAggregateStatistics
          ? `${sampleCount} vente${sampleCount > 1 ? "s" : ""} de référence`
          : `${sampleCount} vente${sampleCount > 1 ? "s" : ""} comparable${sampleCount > 1 ? "s" : ""}`;

  return (
    <div id="market" className="min-w-0 scroll-mt-36">
      <h2 className="font-display text-4xl font-medium text-brand-navy sm:text-5xl">
        Marché local
      </h2>
      <dl className="mt-7 grid gap-4">
        <MarketFact
          icon={<BadgeEuro className="h-5 w-5" />}
          label="Valeur estimée"
          value={
            marketEstimate?.estimatedValueEur
              ? formatPrice(marketEstimate.estimatedValueEur)
              : marketLoading
                ? "Calcul…"
                : "À compléter"
          }
        />
        <MarketFact
          icon={<ChartNoAxesCombined className="h-5 w-5" />}
          label={sampleLabel}
          value={
            marketEstimate?.medianUnitPriceEur
              ? `Médiane ${formatPrice(marketEstimate.medianUnitPriceEur)} / place`
              : marketEstimate?.medianPricePerM2
                ? `Médiane ${formatPricePerM2(marketEstimate.medianPricePerM2)}`
                : "Échantillon à compléter"
          }
        />
        <MarketFact
          icon={<ShieldCheck className="h-5 w-5" />}
          label="Solidité des références"
          value={marketReferenceConfidence(marketEstimate).confidenceLabel}
        />
      </dl>

      {marketEstimate && (
        <div className="mt-5 space-y-2 text-sm leading-relaxed text-brand-navy/75">
          <p>
            Source : {marketEstimate.source} · Période de recherche : {marketEstimate.yearsBack} ans
            {usesAddressHistory
              ? " · Historique de la parcelle à cette adresse"
              : usesAggregateStatistics
                ? ` · Échelle ${aggregateScopeLabel(marketEstimate.geographyLevel)}`
                : ` · Rayon de recherche : ${marketEstimate.radiusM} m`}
            .
          </p>
          <p>
            Ce niveau décrit les données disponibles. Il ne garantit ni le prix de revente, ni
            l’état du bien, ni le résultat des enchères.
          </p>
          {usesAddressHistory && (
            <p>
              Repli sur l’historique d’adresse faute de comparables proches. Ces transactions
              peuvent concerner des lots différents ; elles ne prouvent pas une vente antérieure de
              ce logement.
            </p>
          )}
          {marketEstimate.qualityWarnings.length > 0 && (
            <ul className="list-disc space-y-1 pl-5" aria-label="Limites des données de marché">
              {marketEstimate.qualityWarnings.map((warning, index) => (
                <li key={`${index}-${warning}`}>{warning}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {comparables.length ? (
        <div className="mt-7 rounded-lg border border-slate-200 bg-white p-5 sm:p-6">
          <h3 className="font-display text-2xl font-semibold text-brand-navy sm:text-3xl">
            {usesAddressHistory
              ? "Historique des ventes à cette adresse"
              : "Ventes de référence à proximité"}
          </h3>
          <p className="mt-1 text-sm leading-relaxed text-slate-600">
            {sampleCount} référence{sampleCount > 1 ? "s" : ""} retenue
            {sampleCount > 1 ? "s" : ""} · {comparables.length} détaillée
            {comparables.length > 1 ? "s" : ""} ci-dessous.
          </p>
          <p className="mt-1 text-sm leading-relaxed text-slate-600">
            Transactions DVF · ces prix ne constituent pas des résultats d’adjudication.
          </p>
          <ul
            className="mt-4 divide-y divide-slate-200 border-t border-slate-200"
            aria-label={usesAddressHistory ? "Historique d’adresse" : "Comparables de marché"}
          >
            {comparables.map((item, index) => (
              <li
                key={`${item.date}-${item.totalPrice}-${index}`}
                className="grid gap-2 py-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)_auto] sm:items-center sm:gap-4"
              >
                <div>
                  <p className="text-sm font-semibold">
                    {usesParkingSales
                      ? `${item.unitCount ?? 1} place${(item.unitCount ?? 1) > 1 ? "s" : ""}`
                      : item.surface != null && item.surface > 0
                        ? `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 }).format(item.surface)} m²`
                        : "Surface non renseignée"}
                    {item.distanceM != null ? (
                      <span className="font-normal text-slate-500"> · à {item.distanceM} m</span>
                    ) : null}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">{item.type}</p>
                </div>
                <p className="text-sm text-slate-600">{formatDate(item.date)}</p>
                <div className="sm:text-right">
                  <p className="text-lg font-bold text-brand-navy">
                    {formatPrice(item.totalPrice)}
                  </p>
                  {item.pricePerM2 != null && item.pricePerM2 > 0 ? (
                    <p className="text-xs text-slate-500">{formatPricePerM2(item.pricePerM2)}</p>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="mt-7 border-y border-brand-navy/12 py-5 text-sm leading-relaxed text-brand-navy/65">
          {usesAggregateStatistics
            ? `Estimation indicative fondée sur la médiane DVF à l’échelle ${aggregateScopeLabel(marketEstimate?.geographyLevel)}. Les ventes détaillées apparaîtront dès qu’un échantillon local homogène sera disponible.`
            : "Les ventes comparables seront affichées ici dès qu'un échantillon homogène est disponible."}
        </p>
      )}
    </div>
  );
}

function aggregateScopeLabel(level: MarketEstimate["geographyLevel"]): string {
  if (level === "commune") return "de la commune";
  if (level === "epci") return "de l’intercommunalité";
  return "du département";
}

function MarketFact({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-3">
      <span className="text-gold-text" aria-hidden>
        {icon}
      </span>
      <dt className="text-sm font-medium text-brand-navy sm:text-base">{label}</dt>
      <dd className="text-right text-sm font-semibold text-brand-navy sm:text-base">{value}</dd>
    </div>
  );
}
