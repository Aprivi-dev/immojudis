"use client";

import { useState } from "react";
import { FavoriteButton } from "@/components/FavoriteButton";
import { Button } from "@/components/ui/primitives";
import { formatDate, formatPrice } from "@/lib/format";
import { useSaleDossier } from "./use-sale-dossier";

/**
 * « Enregistrer ce plafond dans mon dossier » : le plafond calculé avec les hypothèses du moment
 * devient l'enchère plafond de « Mon dossier » (la même que celle de la carte et de « Mes favoris »).
 * Le dossier est attaché au suivi de la vente : sans suivi, le bouton propose d'abord de la suivre.
 */
export function SaveCeilingButton({
  saleId,
  ceiling,
}: {
  saleId: string;
  /** Le plafond calculé, en euros ; `null` quand le calcul n'en donne pas. */
  ceiling: number | null;
}) {
  const { userId, query, dossier, savedCeiling, save } = useSaleDossier(saleId);
  const [message, setMessage] = useState("");
  if (!userId) return null;
  const amount =
    ceiling != null && Number.isFinite(ceiling) && ceiling >= 1 ? Math.round(ceiling) : null;

  if (dossier && !dossier.followed) {
    return (
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <FavoriteButton saleId={saleId} />
        <p className="text-sm text-ink-soft">
          Suivez cette vente pour enregistrer ce plafond dans votre dossier.
        </p>
      </div>
    );
  }

  const saved =
    savedCeiling != null
      ? `Plafond enregistré : ${formatPrice(savedCeiling)}${
          dossier?.bidCeilingSavedAt ? `, le ${formatDate(dossier.bidCeilingSavedAt)}` : ""
        }.`
      : "Aucun plafond enregistré pour cette vente.";

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <Button
        variant="primary"
        aria-disabled={amount == null || save.isPending || query.isPending || undefined}
        className="aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
        onClick={() => {
          if (amount == null || save.isPending || query.isPending) return;
          setMessage("");
          save.mutate(
            { bidCeilingEur: amount },
            {
              onSuccess: () => setMessage(`${formatPrice(amount)} enregistré dans votre dossier.`),
            },
          );
        }}
      >
        Enregistrer ce plafond dans mon dossier
      </Button>
      <p
        role="status"
        className={`text-sm ${message ? "font-semibold text-success" : "text-ink-soft"}`}
      >
        {message || (query.isPending ? "Chargement de votre dossier…" : saved)}
      </p>
    </div>
  );
}
