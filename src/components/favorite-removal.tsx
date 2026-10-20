"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/primitives";
import { addFavoriteSale, fetchFavoriteDossier, saveFavoriteDossier } from "@/lib/client-api";
import { favoriteDossierStatusLabel } from "@/lib/favorite-dossier-shared";
import type { RemovedFavoriteDossier } from "@/lib/favorites";
import { formatPrice } from "@/lib/format";

/**
 * Retirer un favori supprime la ligne qui porte « Mon dossier » (statut personnel, enchère
 * plafond). Ce module en tient les deux garde-fous : une confirmation avant le retrait quand le
 * dossier n'est pas vide, et le rétablissement réel du dossier quand la personne annule.
 */

/** Un plafond de 0 € n'est pas une valeur : il n'est ni affiché, ni compté, ni rétabli. */
function hasCeiling(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function dossierHasContent(
  dossier: Partial<RemovedFavoriteDossier> | null | undefined,
): boolean {
  return Boolean(dossier?.personalStatus) || hasCeiling(dossier?.bidCeilingEur);
}

/**
 * « Annuler » après un retrait : recrée le favori, puis y remet le statut et le plafond que la
 * suppression avait emportés (route `favorites/dossier`). Un échec du second temps est dit tel
 * quel : le favori est revenu, pas le dossier.
 */
export async function restoreRemovedFavorite(
  saleId: string,
  dossier: RemovedFavoriteDossier | null | undefined,
): Promise<void> {
  await addFavoriteSale({ data: { saleId } });
  if (!dossier || !dossierHasContent(dossier)) return;
  try {
    await saveFavoriteDossier({
      data: {
        saleId,
        ...(dossier.personalStatus ? { personalStatus: dossier.personalStatus } : {}),
        ...(hasCeiling(dossier.bidCeilingEur) ? { bidCeilingEur: dossier.bidCeilingEur } : {}),
      },
    });
  } catch {
    throw new Error(
      "Le favori est rétabli, mais pas votre statut ni votre enchère plafond. Ressaisissez-les sur la fiche de la vente.",
    );
  }
}

type PendingRemoval = { dossier: Partial<RemovedFavoriteDossier> | null };

function DossierLossSummary({ dossier }: PendingRemoval) {
  if (!dossier) {
    return (
      <>
        Si vous avez enregistré un statut ou une enchère plafond sur cette vente, ils seront effacés
        avec le favori.
      </>
    );
  }
  const parts: string[] = [];
  if (dossier.personalStatus) {
    parts.push(`votre statut « ${favoriteDossierStatusLabel(dossier.personalStatus)} »`);
  }
  if (hasCeiling(dossier.bidCeilingEur)) {
    parts.push(`votre enchère plafond de ${formatPrice(dossier.bidCeilingEur)}`);
  }
  return <>Retirer ce favori efface aussi {parts.join(" et ")}.</>;
}

/**
 * Confirmation du retrait d'un favori. `confirmRemoval(saleId)` lit « Mon dossier » ; s'il est vide
 * elle répond tout de suite `true`, sinon elle ouvre le dialogue et répond au choix de la personne.
 * Une lecture en échec ouvre le dialogue avec une formulation générale : mieux vaut un clic de
 * trop que l'effacement silencieux d'un dossier.
 *
 * `dialog` est à rendre à côté du bouton du cœur. Il est enveloppé : les clics et touches du
 * dialogue remontent sinon, par l'arbre React, jusqu'à la carte (lien, sélection) qui porte le cœur.
 */
export function useFavoriteRemovalConfirmation(): {
  confirmRemoval: (saleId: string) => Promise<boolean>;
  dialog: ReactNode;
} {
  const [pending, setPending] = useState<PendingRemoval | null>(null);
  const resolver = useRef<((confirmed: boolean) => void) | null>(null);

  const settle = useCallback((confirmed: boolean) => {
    resolver.current?.(confirmed);
    resolver.current = null;
    setPending(null);
  }, []);

  useEffect(
    () => () => {
      resolver.current?.(false);
      resolver.current = null;
    },
    [],
  );

  const confirmRemoval = useCallback(async (saleId: string): Promise<boolean> => {
    let dossier: PendingRemoval["dossier"] = null;
    try {
      dossier = (await fetchFavoriteDossier(saleId)).dossier;
      if (!dossierHasContent(dossier)) return true;
    } catch {
      dossier = null;
    }
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
      setPending({ dossier });
    });
  }, []);

  const dialog = (
    <span
      className="contents"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <Dialog open={pending !== null} onOpenChange={(open) => (open ? undefined : settle(false))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Retirer cette vente de vos favoris ?</DialogTitle>
            <DialogDescription>
              {pending ? <DossierLossSummary dossier={pending.dossier} /> : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="secondary" onClick={() => settle(false)}>
              Garder en favori
            </Button>
            <Button variant="danger" onClick={() => settle(true)}>
              Retirer et effacer mon dossier
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </span>
  );

  return { confirmRemoval, dialog };
}
