import type { Metadata } from "next";
import Link from "next/link";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right.js";
import { FeesSimulator } from "@/components/fees-simulator/FeesSimulator";
import { formatScaleDate } from "@/components/fees-simulator/scale-date";
import { Card, PageShell, buttonClasses } from "@/components/ui/primitives";
import { EMOLUMENT_SCALE_DATE, EMOLUMENT_SCALE_REFERENCE } from "@/lib/profitability";

export const metadata: Metadata = {
  alternates: { canonical: "/simulateur-frais-encheres" },
  title: "Simulateur de frais d’enchères immobilières",
  description:
    "Estimez le coût total d’un bien adjugé aux enchères : émoluments, droits de mutation, frais préalables, honoraires et travaux, par département.",
};

export default function Page() {
  return (
    <PageShell
      eyebrow="Simulateur de frais"
      title="Combien coûte vraiment un bien adjugé ?"
      description="Le prix d’adjudication n’est qu’une partie de la dépense. S’y ajoutent les émoluments de l’avocat poursuivant, les droits de mutation, les frais préalables de la procédure, les honoraires de votre avocat et, le cas échéant, les travaux. Saisissez vos hypothèses : le total se met à jour en direct."
    >
      <Card as="section" aria-label="Précisions sur l’estimation" className="mb-6 bg-surface-muted">
        <p className="font-semibold">
          {`Barème au ${formatScaleDate(EMOLUMENT_SCALE_DATE)}`}
          <span className="font-normal text-ink-soft"> ({EMOLUMENT_SCALE_REFERENCE})</span>
        </p>
        <p className="mt-2 text-ink-soft">
          Estimation indicative : les frais préalables réels figurent dans le cahier des conditions
          de vente ; faites vérifier le montant par l’avocat.
        </p>
      </Card>

      <FeesSimulator />

      <section aria-labelledby="suites" className="mt-8">
        <h2 id="suites" className="font-display text-2xl font-semibold">
          Et ensuite ?
        </h2>
        <p className="mt-2 max-w-2xl text-ink-soft">
          Ce simulateur chiffre les frais, pas votre limite d’enchère : l’enchère plafond se fixe
          avec l’offre Analyse.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link href="/sales" className={buttonClasses({ variant: "primary", size: "md" })}>
            Trouver une vente
            <ArrowRight className="size-4" aria-hidden />
          </Link>
          <Link href="/offres" className={buttonClasses({ variant: "secondary", size: "md" })}>
            Fixer son enchère plafond
          </Link>
        </div>
      </section>
    </PageShell>
  );
}
