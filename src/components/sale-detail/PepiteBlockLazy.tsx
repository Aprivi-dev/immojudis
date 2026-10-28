"use client";

import dynamic from "next/dynamic";
import type { ReactNode } from "react";
import { useSalePepiteState } from "@/hooks/use-sale-pepite";

/**
 * Place réservée au bloc (environ 256 px : titre, cinq tests, contrôle d'inondation) tant que ses
 * critères et son code arrivent : sans elle, il s'insère entre deux cartes et pousse la suite de la page.
 */
const RESERVED_SPACE = (
  <div aria-hidden="true" className="min-h-64" data-testid="pepite-reserved" />
);

const PepiteBlock = dynamic(() => import("./PepiteBlock").then((module) => module.PepiteBlock), {
  loading: () => RESERVED_SPACE,
});

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
  const { payload, pending } = useSalePepiteState({
    saleId,
    view: "criteria",
    userKey: "public",
    known,
  });
  if (!payload) return pending ? RESERVED_SPACE : null;
  return <PepiteBlock payload={payload} saleId={saleId} lockedAction={lockedAction} className="" />;
}
