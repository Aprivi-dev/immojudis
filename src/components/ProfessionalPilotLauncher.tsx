"use client";

import ArrowRight from "lucide-react/dist/esm/icons/arrow-right.js";
import { useState } from "react";
import { ProfessionalPilotWorkspace } from "@/components/ProfessionalPilotWorkspace";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { PilotDefinition } from "@/lib/professional-pilots";
import type { AuctionSale } from "@/lib/types";

const pilotAction = {
  tribunal: {
    title: "Préparer votre audience",
    description: "Vérifiez les pièces, chiffrez votre mise et notez les points à clarifier.",
  },
  notary: {
    title: "Préparer votre offre",
    description: "Vérifiez les conditions, chiffrez votre offre et notez les points à clarifier.",
  },
  state: {
    title: "Préparer votre candidature",
    description: "Vérifiez les conditions, chiffrez votre projet et notez les points à clarifier.",
  },
} as const;

export function ProfessionalPilotLauncher({
  sale,
  definition,
  publicDemo = false,
}: {
  sale: AuctionSale;
  definition: PilotDefinition;
  publicDemo?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const action = pilotAction[definition.kind];

  return (
    <section
      id="professional-pilot"
      aria-label="Dossier de travail"
      className="mx-auto max-w-[1260px] scroll-mt-36 px-4 py-5 sm:px-6 lg:px-8"
    >
      <div className="flex flex-col gap-4 rounded-lg border border-brand-navy/12 bg-white px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-7">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-brand-navy/55">
            Outil de travail
          </p>
          <h2 className="mt-1 font-display text-xl font-semibold text-brand-navy">
            {action.title}
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-brand-navy/70">
            {action.description}
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <button
              type="button"
              className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-md border border-brand-navy px-4 py-2 text-sm font-semibold text-brand-navy transition-colors hover:bg-brand-navy hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
            >
              Ouvrir le dossier
              <ArrowRight className="h-4 w-4" aria-hidden />
            </button>
          </DialogTrigger>
          <DialogContent className="max-h-[94dvh] w-[calc(100vw-1rem)] max-w-[980px] gap-0 overflow-y-auto border-0 bg-white p-0 sm:w-[calc(100vw-3rem)] [&>button]:z-20 [&>button]:grid [&>button]:h-10 [&>button]:w-10 [&>button]:place-items-center [&>button]:text-brand-navy [&>button]:opacity-100 [&>button]:hover:bg-slate-100">
            <DialogHeader className="sticky top-0 z-10 border-b border-slate-200 bg-white px-5 py-4 pr-12 text-left sm:px-7">
              <DialogTitle className="font-display text-xl text-brand-navy">
                {definition.title}
              </DialogTitle>
              <DialogDescription>{action.description}</DialogDescription>
            </DialogHeader>
            {open ? (
              <ProfessionalPilotWorkspace
                sale={sale}
                definition={definition}
                publicDemo={publicDemo}
              />
            ) : null}
          </DialogContent>
        </Dialog>
      </div>
    </section>
  );
}
