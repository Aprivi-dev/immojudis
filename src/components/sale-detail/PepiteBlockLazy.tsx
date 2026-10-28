"use client";

import dynamic from "next/dynamic";
import type { ReactNode } from "react";
import { useSalePepite } from "@/hooks/use-sale-pepite";
import { PepiteViewTracker } from "./PepiteViewTracker";

const PepiteBlock = dynamic(() => import("./PepiteBlock").then((module) => module.PepiteBlock));

/**
 * Bloc « Pourquoi cette pépite » de l'aperçu public (version verrouillée : les noms des critères, jamais un
 * montant). La vente est déjà connue comme pépite (`known`, lu avec la fiche) : seule la route des critères est
 * appelée, puis le bloc se charge à la demande.
 */
export function PepiteBlockLazy({
  saleId,
  known,
  lockedAction,
}: {
  saleId: string;
  known: boolean;
  lockedAction: ReactNode;
}) {
  const payload = useSalePepite({ saleId, view: "criteria", userKey: "public", known });
  return payload ? (
    <>
      <PepiteViewTracker payload={payload} saleId={saleId} />
      <PepiteBlock payload={payload} saleId={saleId} lockedAction={lockedAction} className="" />
    </>
  ) : null;
}
