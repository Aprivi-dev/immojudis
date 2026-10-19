import type { Metadata } from "next";
import Link from "next/link";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right.js";
import { FeesSimulator } from "@/components/fees-simulator/FeesSimulator";
import { formatScaleDate } from "@/components/fees-simulator/scale-date";
import { Card, PageShell, buttonClasses } from "@/components/ui/primitives";
import { BreadcrumbJsonLd } from "@/components/BreadcrumbJsonLd";
import { LaunchOfferNote } from "@/components/LaunchOfferNote";
import { pageMetadata } from "@/lib/page-metadata";
import { EMOLUMENT_SCALE_DATE, EMOLUMENT_SCALE_REFERENCE } from "@/lib/profitability";
import { MONTHLY_SALE_UNLOCKS } from "@/lib/sale-unlocks";
import { getSurenchereReminder } from "@/lib/surenchere-reminder";

export const metadata: Metadata = pageMetadata({
  path: "/simulateur-frais-encheres",
  title: "Simulateur de frais d’enchères immobilières",
  description:
    "Estimez le coût total d’un bien adjugé aux enchères : émoluments, droits de mutation, frais préalables, honoraires et travaux, par département.",
});

export default function Page() {
  return (
    <>
      <BreadcrumbJsonLd
        trail={[{ name: "Simulateur de frais d’enchères", path: "/simulateur-frais-encheres" }]}
      />
      <PageContent />
    </>
  );
}

function PageContent() {
  return (
    <PageShell
      eyebrow="Simulateur de frais"
      title="Combien coûte vraiment un bien adjugé ?"
      description="Le prix d’adjudication n’est qu’une partie de la dépense. S’y ajoutent les émoluments proportionnels de vente (répartis entre l’avocat poursuivant et l’avocat de l’adjudicataire), les droits de mutation, les frais préalables de la procédure, les honoraires de votre avocat et, le cas échéant, les travaux. Saisissez vos hypothèses : le total se met à jour en direct. Vous pouvez aussi partir de votre budget pour trouver le prix d’adjudication maximal, ou calculer une surenchère du dixième."
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

      <FeesSimulator surenchereReminder={getSurenchereReminder()} />

      <section aria-labelledby="suites" className="mt-8">
        <h2 id="suites" className="font-display text-2xl font-semibold">
          Et ensuite ?
        </h2>
        <p className="mt-2 max-w-2xl text-ink-soft">
          Ce simulateur chiffre les frais, pas votre limite d’enchère. L’enchère plafond s’ouvre sur{" "}
          {MONTHLY_SALE_UNLOCKS} ventes au tribunal par mois avec le compte gratuit, et sur toutes
          les ventes au tribunal avec l’offre Analyse.
        </p>
        <LaunchOfferNote className="mt-3 max-w-2xl" />
        <div className="mt-4 flex flex-wrap gap-2">
          <Link href="/sales" className={buttonClasses({ variant: "primary", size: "md" })}>
            Trouver une vente
            <ArrowRight className="size-4" aria-hidden />
          </Link>
          <Link
            href="/annonce-exemple"
            className={buttonClasses({ variant: "secondary", size: "md" })}
          >
            Essayer l’enchère plafond sur un exemple
          </Link>
          <Link href="/offres" className={buttonClasses({ variant: "secondary", size: "md" })}>
            Voir les offres
          </Link>
        </div>
      </section>
    </PageShell>
  );
}
