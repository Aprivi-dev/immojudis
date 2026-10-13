"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { PremiumFeaturePreview } from "@/components/PremiumFeaturePreview";
import panelStyles from "@/components/sale-detail/SaleDetailPanels.module.css";
import { useAuth } from "@/hooks/use-auth";
import { UNPROFITABLE_HEADLINE, type CeilingGap } from "@/lib/bid-ceiling-gaps";
import { fetchValuePreview } from "@/lib/client-api";
import { formatPrice, formatStartingPrice } from "@/lib/format";
import type { MarketEstimate } from "@/lib/market.server";
import { getSaleProcedure } from "@/lib/sale-procedure";
import { saleDetailPath } from "@/lib/navigation";
import { getMarketValuationSurfaces } from "@/lib/surface";
import type { AuctionSale } from "@/lib/types";

export function AnalysisDecisionPanel({
  sale,
  marketEstimate,
  marketLoading,
  worksBudget,
  recommendedCeiling,
  ceilingAvailable,
  ceilingGap = null,
  valueReason,
  onAdjust,
  onEditWorks,
}: {
  sale: AuctionSale;
  marketEstimate: MarketEstimate | null;
  marketLoading: boolean;
  /** `null`: not computable yet; `0`: no works retained. */
  worksBudget: number | null;
  recommendedCeiling: number;
  ceilingAvailable: boolean;
  /** Why the ceiling is not a number (missing input, or no profitable bid). */
  ceilingGap?: CeilingGap | null;
  /** Why the market value is missing, when it is (« surface manquante », …). */
  valueReason?: string;
  onAdjust: () => void;
  /** Opens the Travaux tab, where the works budget is chosen. */
  onEditWorks?: () => void;
}) {
  const ceiling = ceilingAvailable ? recommendedCeiling : null;
  const marketValue =
    marketEstimate?.actionable === true ? roundedValue(marketEstimate.estimatedValueEur) : null;
  const missingMarker = (label: string): { main: string; note?: string; compact?: boolean } => {
    if (label === "Mise à prix") return { main: "À confirmer" };
    if (label === "Valeur estimée") {
      return marketLoading
        ? { main: "Calcul…" }
        : { main: "À compléter", note: valueReason ?? "valeur de marché manquante" };
    }
    if (ceilingGap?.kind === "unprofitable") {
      return { main: UNPROFITABLE_HEADLINE, compact: true };
    }
    return {
      main: "À compléter",
      note: ceilingGap?.reason ?? valueReason ?? "valeur de marché manquante",
    };
  };
  const markers = comparisonMarkerPositions({
    start:
      sale.starting_price_eur != null && sale.starting_price_eur > 0
        ? sale.starting_price_eur
        : null,
    ceiling,
    market: marketValue,
  });

  return (
    <aside className={panelStyles.estimationCard} aria-label="Votre analyse de prix">
      <dl className={panelStyles.priceGrid}>
        {markers.map((marker) => {
          const missing = marker.value == null ? missingMarker(marker.label) : null;
          return (
            <div key={marker.label}>
              <dt>{marker.label}</dt>
              <dd className={missing?.compact ? panelStyles.textValue : undefined}>
                {marker.value != null ? formatPrice(marker.value) : missing?.main}
                {missing?.note ? (
                  <small className={panelStyles.valueNote}>{missing.note}</small>
                ) : null}
              </dd>
            </div>
          );
        })}
      </dl>
      <div className={panelStyles.estimationFoot}>
        <p>
          <strong>
            Travaux inclus :{" "}
            {worksBudget == null
              ? "à chiffrer"
              : worksBudget > 0
                ? formatPrice(worksBudget)
                : "aucun (bien repris en l’état)"}
          </strong>
          <span>Plafond indicatif selon vos hypothèses de marché, de frais et de travaux.</span>
        </p>
        <div>
          {onEditWorks ? (
            <button type="button" onClick={onEditWorks}>
              {worksBudget != null && worksBudget > 0
                ? "Modifier les travaux"
                : "Chiffrer les travaux"}
            </button>
          ) : null}
          <a href="#calculation" onClick={onAdjust}>
            Ajuster mes hypothèses
          </a>
          <a href="#why-this-ceiling">Voir le calcul</a>
        </div>
      </div>
      {getMarketValuationSurfaces(sale).builtSurfaceEstimated ? (
        <p className={panelStyles.surfaceCaution}>
          Surface provisoire : {getMarketValuationSurfaces(sale).builtSurfaceAssumption}. À
          confirmer avant de retenir ce plafond.
        </p>
      ) : null}
      {ceiling != null && sale.starting_price_eur != null && ceiling < sale.starting_price_eur ? (
        <p role="status" className={panelStyles.surfaceCaution}>
          Ce scénario donne un plafond inférieur à la mise à prix de{" "}
          {formatPrice(sale.starting_price_eur)}.
        </p>
      ) : null}
    </aside>
  );
}

export function NonJudicialDecisionPanel({
  sale,
  marketEstimate,
  marketLoading,
}: {
  sale: AuctionSale;
  marketEstimate: MarketEstimate | null;
  marketLoading: boolean;
}) {
  const venue = getSaleProcedure(sale).venueType;
  const value =
    marketEstimate?.actionable === true ? roundedValue(marketEstimate.estimatedValueEur) : null;
  return (
    <aside className={panelStyles.estimationCard} aria-label="Repères de prix">
      <dl className={panelStyles.priceGrid}>
        <div>
          <dt>{venue === "state" ? "Prix publié" : "Mise à prix"}</dt>
          <dd>{startingPriceOrConfirm(sale.starting_price_eur)}</dd>
        </div>
        <div>
          <dt>Valeur estimée</dt>
          <dd>
            {value == null ? (marketLoading ? "Calcul…" : "À compléter") : formatPrice(value)}
          </dd>
        </div>
        <div>
          <dt>Conditions de vente</dt>
          <dd className={panelStyles.textValue}>À vérifier dans le dossier officiel</dd>
        </div>
      </dl>
      <div className={panelStyles.estimationFoot}>
        <p>Les frais et les modalités dépendent des conditions publiées par l’organisateur.</p>
        <a href="#participation">Voir les démarches</a>
      </div>
    </aside>
  );
}

export function DiscoveryDecisionPanel({ sale }: { sale: AuctionSale }) {
  const { user, loading: authLoading } = useAuth();
  // The value route requires an account: a visitor never gets an answer from it.
  const preview = useQuery({
    queryKey: ["value-preview", sale.id],
    queryFn: () => fetchValuePreview(sale.id),
    enabled: Boolean(user),
    staleTime: 60 * 60_000,
    retry: false,
  });
  const value = user && preview.data?.available ? preview.data : null;
  const salePath = saleDetailPath(sale.id);
  return (
    <aside className={panelStyles.estimationCard} aria-label="Aperçu des repères de prix">
      <dl className={panelStyles.priceGrid}>
        <div>
          <dt>Mise à prix</dt>
          <dd>{startingPriceOrConfirm(sale.starting_price_eur)}</dd>
        </div>
        <div>
          <dt>Valeur estimée</dt>
          <dd className={value ? undefined : panelStyles.textValue}>
            {value ? (
              `${formatPrice(value.lowEur)} – ${formatPrice(value.highEur)}`
            ) : !user ? (
              authLoading ? (
                "Calcul…"
              ) : (
                <Link
                  href={`/login?mode=investor&redirect=${encodeURIComponent(salePath)}`}
                  className={panelStyles.valueLink}
                >
                  Créez un compte gratuit pour voir la fourchette de valeur
                </Link>
              )
            ) : preview.isLoading ? (
              "Calcul…"
            ) : (
              "Pas encore d’estimation"
            )}
          </dd>
        </div>
        <div>
          <dt>Enchère plafond</dt>
          <dd className={panelStyles.textValue}>
            Avec l’offre Analyse ou en débloquant cette vente
          </dd>
        </div>
      </dl>
      {value?.discountPct != null ? (
        <p className={panelStyles.surfaceCaution} role="status">
          {value.discountPct > 0
            ? `La mise à prix est environ ${value.discountPct} % sous la valeur estimée du bien.`
            : value.discountPct < 0
              ? `La mise à prix est environ ${-value.discountPct} % au-dessus de la valeur estimée du bien.`
              : "La mise à prix est proche de la valeur estimée du bien."}{" "}
          Reste à savoir jusqu’où enchérir une fois les frais, les travaux et la libération du bien
          comptés : c’est le calcul de l’enchère plafond.
        </p>
      ) : null}
      <PremiumFeaturePreview
        title="Votre enchère plafond, les comparables et les travaux avec l’offre Analyse"
        description="Le calcul complet de la mise à ne pas dépasser : valeur du bien, marge, travaux, libération, portage et tous les frais de la vente, avec les ventes comparables du secteur."
        labels={["Enchère plafond", "Ventes comparables", "Travaux et frais"]}
      />
    </aside>
  );
}

/** « À confirmer » for an absent or zero starting price, the amount otherwise. */
function startingPriceOrConfirm(value: number | null | undefined): string {
  return value != null && value > 0 ? formatStartingPrice(value) : "À confirmer";
}

/** A model estimate is not precise to the euro: show it to the nearest thousand. */
function roundedValue(value: number | null | undefined): number | null {
  return value == null ? null : Math.round(value / 1000) * 1000;
}

function comparisonMarkerPositions({
  start,
  ceiling,
  market,
}: {
  start: number | null;
  ceiling: number | null;
  market: number | null;
}) {
  const values = [start, ceiling, market].filter((value): value is number => value != null);
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 1;
  const span = Math.max(1, max - min);
  const position = (value: number | null, fallback: number) =>
    value == null ? fallback : 8 + ((value - min) / span) * 84;

  return [
    { label: "Mise à prix", value: start, position: position(start, 8) },
    { label: "Enchère plafond", value: ceiling, position: position(ceiling, 50) },
    { label: "Valeur estimée", value: market, position: position(market, 92) },
  ];
}
