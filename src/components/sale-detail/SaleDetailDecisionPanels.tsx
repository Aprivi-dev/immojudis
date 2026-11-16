"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import type { ReactNode } from "react";
import { Terme } from "@/components/ceiling/Terme";
import { SaleSignalFeedback } from "@/components/SaleSignalFeedback";
import { isMarketGapPosition } from "@/components/sale-detail/MarketReference";
import { UnlockCallToAction } from "@/components/sale-detail/UnlockCallToAction";
import panelStyles from "@/components/sale-detail/SaleDetailPanels.module.css";
import { useAuth } from "@/hooks/use-auth";
import { fetchValuePreview } from "@/lib/client-api";
import { formatNumber, formatPrice, formatStartingPrice } from "@/lib/format";
import type { MarketEstimate } from "@/lib/market.server";
import { MARKET_GAP_BAND_LABELS } from "@/lib/market-gap-band";
import { ceilingTermsFor } from "@/lib/fee-regime-labels";
import { feeRegimeKeysForVenue, type FeeRegimeKey } from "@/lib/fee-regime-open";
import { getSaleProcedure } from "@/lib/sale-procedure";
import { loginPathWithRedirect, saleDetailPath } from "@/lib/navigation";
import * as queryKeys from "@/lib/query-keys";
import type { AuctionSale } from "@/lib/types";

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
  // The value route requires an account: a visitor never gets an answer from it. A sale the free
  // account has not unlocked gets the level of the gap only, never the range nor a percentage.
  const preview = useQuery({
    queryKey: queryKeys.valuePreview(sale.id, "discovery"),
    queryFn: () => fetchValuePreview(sale.id),
    enabled: Boolean(user),
    staleTime: 60 * 60_000,
    retry: false,
  });
  const teaser = user && preview.data?.access === "teaser" ? preview.data : null;
  const band = teaser?.band ?? null;
  const comparables = teaser?.comparables?.count ? teaser.comparables : null;
  const salePath = saleDetailPath(sale.id);
  return (
    <aside className={panelStyles.estimationCard} aria-label="Aperçu des repères de prix">
      <dl className={panelStyles.priceGrid}>
        <div>
          <dt>{markerLabel("Mise à prix")}</dt>
          <dd>{startingPriceOrConfirm(sale.starting_price_eur)}</dd>
        </div>
        <div>
          <dt>Repère marché</dt>
          <dd className={panelStyles.textValue}>
            {band ? (
              MARKET_GAP_BAND_LABELS[band]
            ) : !user ? (
              authLoading ? (
                "Calcul…"
              ) : (
                <Link
                  href={loginPathWithRedirect(salePath, { reason: "fiche" })}
                  className={panelStyles.valueLink}
                >
                  Créez un compte gratuit pour voir le repère marché
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
      {band && isMarketGapPosition(band) ? (
        <>
          <p className={panelStyles.surfaceCaution} role="status">
            {`Reste à savoir jusqu’où ${ceilingTerms == null || ceilingTerms.ceilingTerm === "enchère plafond" ? "enchérir" : "aller"} une fois les frais, les travaux et la libération du bien comptés : c’est le calcul de ${ceilingTerms?.ceilingTermWithArticle ?? "l’enchère plafond"}.`}
          </p>
          <SaleSignalFeedback saleId={sale.id} signal="market_gap_band" />
        </>
      ) : null}
      {comparables ? (
        <div className={panelStyles.estimationFoot} data-testid="comparables-teaser">
          <p>
            <strong>{comparablesTeaserLine(comparables)}</strong>
          </p>
          <div>
            <UnlockCallToAction />
          </div>
        </div>
      ) : null}
    </aside>
  );
}

/**
 * Ce qu'un compte gratuit lit des ventes comparables d'une vente qu'il n'a pas débloquée : leur nombre
 * et le rayon de recherche, sans aucune vente ni montant.
 */
function comparablesTeaserLine({ count, radiusM }: { count: number; radiusM: number }): string {
  const s = count > 1 ? "s" : "";
  return `${formatNumber(count)} vente${s} comparable${s} trouvée${s} dans un rayon de ${formatNumber(radiusM)} m`;
}

/** The two terms a reader may not know get a « ? » definition; the others stay plain text. */
function markerLabel(label: string): ReactNode {
  if (label === "Mise à prix") return <Terme terme="mise-a-prix">{label}</Terme>;
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
