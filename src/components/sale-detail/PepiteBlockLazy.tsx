"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, type ReactNode } from "react";
import { PepiteIcon } from "@/components/PepiteBadge";
import { useSalePepiteState } from "@/hooks/use-sale-pepite";
import { PEPITE_ANCHOR, PEPITE_METHOD_LINK_LABEL, PEPITE_METHOD_PATH } from "@/lib/pepite-copy";
import { PepiteViewTracker } from "./PepiteViewTracker";

const PepiteBlock = dynamic(() => import("./PepiteBlock").then((module) => module.PepiteBlock));

/**
 * Bloc « Pourquoi cette pépite » de l'aperçu public (version verrouillée : les noms des critères, jamais un
 * montant). La vente est déjà connue comme pépite (`known`, lu avec la fiche) : seule la route des critères est
 * appelée, puis le bloc se charge à la demande.
 *
 * Pendant la lecture, un emplacement de hauteur fixe tient la place du bloc (la page ne saute pas quand il
 * arrive) ; si la lecture échoue (503, 429, réseau), une ligne le dit et renvoie à la méthode, au lieu de laisser
 * le lien « Pourquoi ? » de la pastille mener nulle part. `onLoadedChange` dit à la fiche si le bloc, et donc
 * l'ancre `#pepite`, existe : la pastille ne propose « Pourquoi ? » qu'à ce moment.
 */
export function PepiteBlockLazy({
  saleId,
  known,
  lockedAction,
  onLoadedChange,
}: {
  saleId: string;
  known: boolean;
  lockedAction: ReactNode;
  onLoadedChange?: (loaded: boolean) => void;
}) {
  const { payload, status } = useSalePepiteState({
    saleId,
    view: "criteria",
    userKey: "public",
    known,
  });
  const loaded = payload !== null;
  useEffect(() => {
    onLoadedChange?.(loaded);
  }, [loaded, onLoadedChange]);

  if (payload) {
    return (
      <>
        <PepiteViewTracker payload={payload} saleId={saleId} />
        <PepiteBlock payload={payload} saleId={saleId} lockedAction={lockedAction} className="" />
      </>
    );
  }
  if (status === "loading") {
    return (
      <section
        aria-busy="true"
        aria-label="Pépite : chargement du détail"
        data-testid="pepite-block-loading"
        className="min-h-44 rounded-lg border border-gold bg-white p-4 sm:p-5"
      >
        <p className="flex items-center gap-2 text-lg font-semibold text-brand-navy">
          <PepiteIcon className="size-5" />
          Pépite
        </p>
        <div className="mt-4 space-y-3" aria-hidden>
          <div className="h-4 w-3/4 rounded bg-surface-muted" />
          <div className="h-4 w-2/3 rounded bg-surface-muted" />
          <div className="h-4 w-1/2 rounded bg-surface-muted" />
        </div>
      </section>
    );
  }
  if (status === "error") {
    return (
      <section
        id={PEPITE_ANCHOR}
        aria-label="Pépite : détail indisponible"
        data-testid="pepite-block-error"
        className="rounded-lg border border-gold bg-white p-4 text-sm text-foreground sm:p-5"
      >
        <p role="status">
          Le détail du repère « Pépite » n’a pas pu être chargé. Réessayez dans un instant.{" "}
          <Link
            href={PEPITE_METHOD_PATH}
            prefetch={false}
            className="inline-flex min-h-11 items-center font-semibold text-gold-text underline underline-offset-4"
          >
            {PEPITE_METHOD_LINK_LABEL}
          </Link>
        </p>
      </section>
    );
  }
  return null;
}
