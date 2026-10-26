"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/primitives";
import { fetchSaleChangeEvents } from "@/lib/client-api";
import { formatDate, formatPrice } from "@/lib/format";
import * as queryKeys from "@/lib/query-keys";
import { changesSinceCeiling } from "@/lib/ceiling-staleness";

const reviewedKey = (userId: string, saleId: string) =>
  `immojudis:ceiling-reviewed:${userId}:${saleId}`;

function readReviewed(userId: string, saleId: string): string | null {
  try {
    return window.localStorage.getItem(reviewedKey(userId, saleId));
  } catch {
    return null;
  }
}

/**
 * « Plafond à vérifier » : l'enchère plafond enregistrée dans « Mon dossier » date d'avant un
 * changement de la vente (mise à prix, date, documents) détecté par le suivi des changements.
 * Mêmes droits que ce suivi (offre Analyse) : un refus (403) ou une panne ne montre rien. Rien n'est
 * recalculé ni modifié ici : le message renvoie au calcul de la fiche. La base ne rafraîchit la date
 * d'enregistrement que si le MONTANT change (`touch_favorite_dossier`) : qui a recalculé et garde
 * le même montant le dit d'un clic, mémorisé dans ce navigateur jusqu'au changement suivant.
 */
export function StaleCeilingNotice({
  saleId,
  userId,
  savedAt,
  ceiling,
  canRecalculate,
}: {
  saleId: string;
  userId: string;
  /** `bid_ceiling_saved_at` du dossier. */
  savedAt: string | null;
  ceiling: number;
  /** Le calcul de la fiche (`#calculation`) existe pour ce compte : le lien y mène. */
  canRecalculate: boolean;
}) {
  const [reviewed, setReviewed] = useState(() => readReviewed(userId, saleId));
  const query = useQuery({
    queryKey: queryKeys.saleChangeEventsForSale(userId, saleId),
    queryFn: () => fetchSaleChangeEvents({ saleId, includeDismissed: true, limit: 50 }),
    enabled: savedAt != null,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const stale = query.data ? changesSinceCeiling(query.data.events, savedAt) : null;
  if (!stale) return null;
  if (reviewed && Date.parse(reviewed) >= Date.parse(stale.lastDetectedAt)) return null;

  function keepCeiling() {
    if (!stale) return;
    try {
      window.localStorage.setItem(reviewedKey(userId, saleId), stale.lastDetectedAt);
    } catch {
      // Navigateur sans stockage : le message se ferme pour cette visite seulement.
    }
    setReviewed(stale.lastDetectedAt);
  }

  const topics = new Intl.ListFormat("fr", { style: "long", type: "conjunction" }).format(
    stale.topics,
  );
  return (
    <div
      data-testid="stale-ceiling"
      className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs leading-relaxed text-amber-950"
    >
      <p className="font-semibold">Plafond à vérifier</p>
      <p className="mt-1">
        Votre plafond de {formatPrice(ceiling)} a été enregistré
        {savedAt ? ` le ${formatDate(savedAt)}` : ""}. Depuis, nous avons détecté un changement
        concernant {topics} (le {formatDate(stale.lastDetectedAt)}). Il n’en tient peut-être pas
        compte.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {canRecalculate ? (
          <a
            href="#calculation"
            className="inline-flex min-h-11 items-center font-semibold underline underline-offset-2"
          >
            Recalculer mon plafond
          </a>
        ) : null}
        <Button variant="ghost" size="sm" onClick={keepCeiling}>
          J’ai vérifié, je le garde
        </Button>
      </div>
    </div>
  );
}
