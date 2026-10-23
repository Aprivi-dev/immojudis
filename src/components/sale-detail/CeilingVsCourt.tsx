"use client";

import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/primitives";
import {
  RELIABILITY_EXPLANATIONS,
  RELIABILITY_LABELS,
  formatPercent,
  formatRatio,
  type AuctionScenariosResponse,
} from "@/lib/auction-scenarios";
import { ceilingPosition } from "@/lib/ceiling-vs-court";
import { fetchAuctionScenarios } from "@/lib/client-api";
import { formatPrice } from "@/lib/format";
import { queryKeys, type SaleAccessMode } from "@/lib/query-keys";

/**
 * « Mon plafond face au tribunal » : à côté de l'enchère plafond calculée, la part des ventes
 * comparables du tribunal adjugées au-dessous. Mêmes données, mêmes droits et même fiabilité que
 * « Scénarios d'enchères » (`AuctionScenariosSection`, qui partage la lecture : une seule requête) ;
 * rien n'est affiché tant que ces chiffres manquent (données insuffisantes, erreur, droits).
 */
export function CeilingVsCourt({
  saleId,
  ceiling,
  access,
  userKey,
}: {
  saleId: string;
  /** L'enchère plafond calculée, en euros. */
  ceiling: number;
  access: SaleAccessMode;
  userKey: string;
}) {
  const query = useQuery<AuctionScenariosResponse>({
    queryKey: queryKeys.auctionScenarios(saleId, access, userKey),
    queryFn: () => fetchAuctionScenarios(saleId),
    staleTime: 30 * 60_000,
    retry: false,
  });
  const data = query.data;
  const figures = data?.scenarios;
  const startingPrice = data?.startingPrice;
  if (!data || !figures || figures.status !== "ok" || !startingPrice) return null;
  const position = ceilingPosition(figures.scenarios, ceiling, startingPrice);
  if (!position) return null;

  const court = data.courtName ?? "ce tribunal";
  const share = position.kind === "share" ? Math.round(position.share * 100) : null;
  return (
    <Card as="section" aria-labelledby="ceiling-vs-court-title" className="mt-4">
      <h3 id="ceiling-vs-court-title" className="font-display text-xl text-brand-navy">
        Mon plafond face au tribunal
      </h3>
      <p className="mt-2 text-sm leading-relaxed" data-testid="ceiling-vs-court">
        {position.kind === "below_start" ? (
          <>
            Votre enchère plafond ({formatPrice(ceiling)}) est inférieure à la mise à prix (
            {formatPrice(startingPrice)}) : une enchère ne peut pas être inférieure à la mise à
            prix.
          </>
        ) : (
          <>
            {position.atLeast ? "Au moins " : "Environ "}
            <strong>{share === 0 ? "moins de 1 %" : formatPercent((share ?? 0) / 100)}</strong> des
            ventes comparables du {court} ont été adjugées à un prix inférieur à votre plafond de{" "}
            {formatPrice(ceiling)} ({formatRatio(position.ratio)} la mise à prix).
          </>
        )}
      </p>
      {figures.reliability ? (
        <p className="mt-1 text-xs leading-relaxed text-ink-soft">
          Niveau de fiabilité : <strong>{RELIABILITY_LABELS[figures.reliability]}</strong> (
          {RELIABILITY_EXPLANATIONS[figures.reliability]}).
        </p>
      ) : null}
      <p className="mt-1 text-xs leading-relaxed text-ink-soft">
        Estimation sur les seules ventes adjugées, avant éventuelle surenchère et hors frais : ni
        les reports ni les ventes sans enchérisseur n’y figurent. Ce n’est pas une probabilité
        d’emporter la vente. <a href="#statistiques">Voir les scénarios d’enchères</a>.
      </p>
    </Card>
  );
}
