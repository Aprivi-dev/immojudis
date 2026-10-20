"use client";

import dynamic from "next/dynamic";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { PilotDefinition } from "@/lib/professional-pilots";
import type { AuctionSale } from "@/lib/types";

const pilotDescription = {
  tribunal: "Vérifiez les pièces, chiffrez votre mise et notez les points à clarifier.",
  notary: "Vérifiez les conditions, chiffrez votre offre et notez les points à clarifier.",
  state: "Vérifiez les conditions, chiffrez votre projet et notez les points à clarifier.",
} as const;

const ProfessionalPilotWorkspace = dynamic(
  () =>
    import("@/components/ProfessionalPilotWorkspace").then(
      (module) => module.ProfessionalPilotWorkspace,
    ),
  {
    loading: () => (
      <p className="p-6 text-sm text-muted-foreground" role="status">
        Chargement du dossier…
      </p>
    ),
  },
);

/**
 * Dialogue du dossier de travail Analyse (pièces, budget, vérifications). Il s'ouvre depuis
 * « Mon dossier » (bouton « Ouvrir le dossier de travail », voir `SaleFileCard`) : « Mon dossier »
 * est l'unique porte d'entrée, le statut et l'enchère plafond y restent enregistrés.
 */
export function ProfessionalPilotLauncher({
  sale,
  definition,
  publicDemo = false,
  open,
  onOpenChange,
}: {
  sale: AuctionSale;
  definition: PilotDefinition;
  publicDemo?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[94dvh] w-[calc(100vw-1rem)] max-w-[980px] gap-0 overflow-y-auto border-0 bg-white p-0 sm:w-[calc(100vw-3rem)] [&>button]:z-20 [&>button]:grid [&>button]:h-10 [&>button]:w-10 [&>button]:place-items-center [&>button]:text-brand-navy [&>button]:opacity-100 [&>button]:hover:bg-slate-100">
        <DialogHeader className="sticky top-0 z-10 border-b border-slate-200 bg-white px-5 py-4 pr-12 text-left sm:px-7">
          <DialogTitle className="font-display text-xl text-brand-navy">
            {definition.title}
          </DialogTitle>
          <DialogDescription>{pilotDescription[definition.kind]}</DialogDescription>
        </DialogHeader>
        {open ? (
          <ProfessionalPilotWorkspace sale={sale} definition={definition} publicDemo={publicDemo} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
