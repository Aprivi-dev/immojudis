"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import type { ReactNode } from "react";
import { Terme } from "@/components/ceiling/Terme";
import type { CeilingWording } from "@/components/sale-detail/SaleListing";
import { PremiumFeaturePreview } from "@/components/PremiumFeaturePreview";
import { SaleSignalFeedback } from "@/components/SaleSignalFeedback";
import { UnlockCallToAction } from "@/components/sale-detail/UnlockCallToAction";
import panelStyles from "@/components/sale-detail/SaleDetailPanels.module.css";
import { useAuth } from "@/hooks/use-auth";
import {
  UNPROFITABLE_EXPLANATION,
  UNPROFITABLE_HEADLINE,
  type CeilingGap,
} from "@/lib/bid-ceiling-gaps";
import { describeCeilingStartGap } from "@/lib/ceiling-start-gap";
import { fetchValuePreview } from "@/lib/client-api";
import { formatPrice, formatStartingPrice } from "@/lib/format";
import type { MarketEstimate } from "@/lib/market.server";
import { describeMarketGap } from "@/lib/market-gap";
import type { CeilingMarketEstimate } from "@/lib/market-estimate-ceiling";
import { ceilingTermsFor } from "@/lib/fee-regime-labels";
import { feeRegimeKeysForVenue, type FeeRegimeKey } from "@/lib/fee-regime-open";
import { getSaleProcedure } from "@/lib/sale-procedure";
import { loginPathWithRedirect, saleDetailPath } from "@/lib/navigation";
import { getMarketValuationSurfaces } from "@/lib/surface";
import type { AuctionSale } from "@/lib/types";

export function AnalysisDecisionPanel({
  sale,
  marketEstimate,
  marketLoading,
  worksBudget,
  recommendedCeiling,
  ceilingAvailable,
  startingPriceGap,
  ceilingGap = null,
  ceilingWording = null,
  valueReason,
  onAdjust,
  onEditWorks,
}: {
  sale: AuctionSale;
  /** The ceiling projection is enough here: this panel is also served to an unlocked sale. */
  marketEstimate: CeilingMarketEstimate | null;
  marketLoading: boolean;
  /** `null`: not computable yet; `0`: no works retained. */
  worksBudget: number | null;
  recommendedCeiling: number;
  ceilingAvailable: boolean;
  /** `startingPriceGap` of the ceiling plan: ceiling minus starting price, when both exist. */
  startingPriceGap?: number | null;
  /** Why the ceiling is not a number (missing input, or no profitable bid). */
  ceilingGap?: CeilingGap | null;
  /** Wording of the ceiling of this sale (« offre plafond »…); absent: the tribunal's. */
  ceilingWording?: CeilingWording | null;
  /** Why the market value is missing, when it is (« surface manquante », …). */
  valueReason?: string;
  onAdjust: () => void;
  /** Opens the Travaux tab, where the works budget is chosen. */
  onEditWorks?: () => void;
}) {
  const ceiling = ceilingAvailable ? recommendedCeiling : null;
  const marketValue =
    marketEstimate?.actionable === true ? roundedValue(marketEstimate.estimatedValueEur) : null;
  const ceilingLabel = ceilingWording?.label ?? "Enchère plafond (simulation)";
  const startLabel = ceilingWording?.byOffers ? "Première offre possible" : "Mise à prix";
  const missingMarker = (label: string): { main: string; note?: string; compact?: boolean } => {
    if (label === startLabel) return { main: "À confirmer" };
    if (label === "Valeur estimée") {
      return marketLoading
        ? { main: "Calcul…" }
        : { main: "À compléter", note: valueReason ?? "valeur de marché manquante" };
    }
    if (ceilingGap?.kind === "unprofitable") {
      return { main: UNPROFITABLE_HEADLINE, note: UNPROFITABLE_EXPLANATION, compact: true };
    }
    return {
      main: "À compléter",
      note: ceilingGap?.reason ?? valueReason ?? "valeur de marché manquante",
    };
  };
  const startGap = describeCeilingStartGap(
    {
      available: ceilingAvailable,
      reachable: ceilingAvailable,
      maxBid: recommendedCeiling,
      // The engine's gap when the caller has it; the same difference otherwise.
      startingPriceGap:
        startingPriceGap !== undefined
          ? startingPriceGap
          : sale.starting_price_eur != null && sale.starting_price_eur > 0
            ? recommendedCeiling - sale.starting_price_eur
            : null,
    },
    sale.starting_price_eur,
    ceilingWording?.terms,
  );
  const markers = comparisonMarkerPositions({
    start:
      sale.starting_price_eur != null && sale.starting_price_eur > 0
        ? sale.starting_price_eur
        : null,
    ceiling,
    market: marketValue,
    startLabel,
    ceilingLabel,
  });

  return (
    <aside className={panelStyles.estimationCard} aria-label="Votre analyse de prix">
      <dl className={panelStyles.priceGrid}>
        {markers.map((marker) => {
          const missing = marker.value == null ? missingMarker(marker.label) : null;
          return (
            <div key={marker.label}>
              <dt>{markerLabel(marker.label)}</dt>
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
          <strong>{worksLine(worksBudget)}</strong>
          <span>{ceilingLabel}, selon vos hypothèses de marché, de frais et de travaux.</span>
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
      {startGap ? (
        <p
          role="status"
          className={startGap.kind === "above" ? undefined : panelStyles.surfaceCaution}
        >
          {startGap.text}
        </p>
      ) : null}
    </aside>
  );
}

export function NonJudicialDecisionPanel({
  sale,
  marketEstimate,
  marketLoading,
  priceBlocked = false,
}: {
  sale: AuctionSale;
  marketEstimate: MarketEstimate | null;
  marketLoading: boolean;
  /** The AI review blocks the price: `sale` then carries none, which is not « not published ». */
  priceBlocked?: boolean;
}) {
  const venue = getSaleProcedure(sale).venueType;
  const value =
    marketEstimate?.actionable === true ? roundedValue(marketEstimate.estimatedValueEur) : null;
  return (
    <aside className={panelStyles.estimationCard} aria-label="Repères de prix">
      <dl className={panelStyles.priceGrid}>
        <div>
          <dt>{venue === "state" ? "Prix publié" : markerLabel("Mise à prix")}</dt>
          <dd>
            {/* Cession domaniale sans prix : la source n'en publie pas. */}
            {venue === "state" && !priceBlocked && !((sale.starting_price_eur ?? 0) > 0)
              ? "Prix non publié"
              : startingPriceOrConfirm(sale.starting_price_eur)}
          </dd>
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

export function DiscoveryDecisionPanel({
  sale,
  openFeeRegimes,
}: {
  sale: AuctionSale;
  /** Fee regimes whose bid ceiling is open (see `parseOpenFeeRegimes`); absent: every regime whose rules are defined. */
  openFeeRegimes?: readonly FeeRegimeKey[];
}) {
  // The unlock is promised only for a sale whose fee regime is open: it opens the bid ceiling.
  const ceilingTerms = ceilingTermsFor(
    feeRegimeKeysForVenue(getSaleProcedure(sale).venueType, openFeeRegimes),
  );
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
  // `describeMarketGap` is also the guard: an implausible gap never reaches the page as a %.
  const gapSentence = value ? describeMarketGap(value) : null;
  return (
    <aside className={panelStyles.estimationCard} aria-label="Aperçu des repères de prix">
      <dl className={panelStyles.priceGrid}>
        <div>
          <dt>{markerLabel("Mise à prix")}</dt>
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
                  href={loginPathWithRedirect(salePath, { reason: "fiche" })}
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
          <dt>
            {markerLabel(ceilingTerms?.ceilingSimulationLabel ?? "Enchère plafond (simulation)")}
          </dt>
          <dd className={panelStyles.textValue}>
            Avec l’offre Analyse ou en débloquant cette vente
            <div className={panelStyles.valueNote}>
              <UnlockCallToAction
                onlyWithUnlockCard
                primaryClassName={panelStyles.valueLink}
                secondaryClassName={panelStyles.valueLink}
              />
            </div>
          </dd>
        </div>
      </dl>
      {gapSentence ? (
        <>
          <p className={panelStyles.surfaceCaution} role="status">
            {gapSentence}
            {value?.gapWithheld
              ? null
              : ` Reste à savoir jusqu’où ${ceilingTerms == null || ceilingTerms.ceilingTerm === "enchère plafond" ? "enchérir" : "aller"} une fois les frais, les travaux et la libération du bien comptés : c’est le calcul de ${ceilingTerms?.ceilingTermWithArticle ?? "l’enchère plafond"}.`}
          </p>
          {value?.gapWithheld ? null : (
            <SaleSignalFeedback saleId={sale.id} signal="market_gap_band" />
          )}
        </>
      ) : null}
      <PremiumFeaturePreview
        title={
          ceilingTerms
            ? `Les comparables et les travaux avec l’offre Analyse ; ${ceilingTerms.ceilingTermWithArticle} aussi en débloquant cette vente`
            : "Les comparables et les travaux avec l’offre Analyse"
        }
        description="Le calcul complet de la mise à ne pas dépasser : valeur du bien, marge, travaux, libération, portage et tous les frais de la vente, avec les ventes comparables du secteur."
        labels={[
          ceilingTerms?.ceilingSimulationLabel ?? "Enchère plafond (simulation)",
          "Ventes comparables",
          "Travaux et frais",
        ]}
        unlockOffer={ceilingTerms != null}
      />
    </aside>
  );
}

/**
 * What the ceiling rests on as far as works go. Without a works budget the ceiling is NOT after
 * works: say so, rather than « Travaux inclus : à chiffrer » which read as if works were counted.
 */
function worksLine(worksBudget: number | null): string {
  if (worksBudget == null) {
    return "Plafond hors travaux : ajoutez votre budget travaux pour l’affiner";
  }
  return worksBudget > 0
    ? `Plafond après ${formatPrice(worksBudget)} de travaux`
    : "Travaux inclus : aucun (bien repris en l’état)";
}

/** The two terms a reader may not know get a « ? » definition; the others stay plain text. */
function markerLabel(label: string): ReactNode {
  if (label === "Mise à prix") return <Terme terme="mise-a-prix">{label}</Terme>;
  if (label === "Première offre possible") return <Terme terme="premiere-offre">{label}</Terme>;
  if (label === "Offre plafond (simulation)") {
    return <Terme terme="offre-plafond">{label}</Terme>;
  }
  if (/plafond/i.test(label)) return <Terme terme="enchere-plafond">{label}</Terme>;
  return label;
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
  startLabel,
  ceilingLabel,
}: {
  start: number | null;
  ceiling: number | null;
  market: number | null;
  startLabel: string;
  ceilingLabel: string;
}) {
  const values = [start, ceiling, market].filter((value): value is number => value != null);
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 1;
  const span = Math.max(1, max - min);
  const position = (value: number | null, fallback: number) =>
    value == null ? fallback : 8 + ((value - min) / span) * 84;

  return [
    { label: startLabel, value: start, position: position(start, 8) },
    { label: ceilingLabel, value: ceiling, position: position(ceiling, 50) },
    { label: "Valeur estimée", value: market, position: position(market, 92) },
  ];
}
