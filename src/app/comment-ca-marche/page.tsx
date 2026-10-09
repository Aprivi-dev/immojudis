import type { Metadata } from "next";
import Link from "next/link";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right.js";
import BadgeEuro from "lucide-react/dist/esm/icons/badge-euro.js";
import FileSearch from "lucide-react/dist/esm/icons/file-search.js";
import Scale from "lucide-react/dist/esm/icons/scale.js";
import Search from "lucide-react/dist/esm/icons/search.js";
import { Card, PageShell, buttonClasses } from "@/components/ui/primitives";

export const metadata: Metadata = {
  alternates: { canonical: "/comment-ca-marche" },
  title: "Comment ça marche",
  description:
    "Trouver une vente aux enchères, comprendre le bien, fixer son enchère plafond et se faire accompagner : les quatre étapes d’Immojudis.",
};

const STEPS = [
  {
    icon: Search,
    title: "Trouver une vente",
    text: "Cherchez par ville, département ou région, puis filtrez par type de vente (tribunal, notaire, domaine), budget et surface. Créez une alerte : un email récapitulatif vous signale les nouvelles ventes qui vous correspondent.",
    links: [{ href: "/sales", label: "Ouvrir le catalogue" }],
  },
  {
    icon: FileSearch,
    title: "Comprendre le bien",
    text: "La fiche réunit les photos, la procédure, les pièces du dossier, l’occupation, les risques de la commune et des ventes comparables. Comparez jusqu’à trois biens côte à côte pour repérer le bon dossier.",
    links: [{ href: "/annonce-exemple", label: "Voir une fiche exemple" }],
  },
  {
    icon: BadgeEuro,
    title: "Fixer son enchère plafond",
    text: "Le simulateur chiffre votre enchère plafond : valeur estimée, frais, travaux et marge de sécurité, que vous ajustez selon votre projet. Fixez la limite avant l’audience, puis tenez-vous-y.",
    links: [
      { href: "/annonce-exemple", label: "Essayer le simulateur" },
      { href: "/offres", label: "Voir les offres" },
    ],
  },
  {
    icon: Scale,
    title: "Se faire accompagner",
    text: "Pour une vente au tribunal, un avocat du barreau compétent porte vos enchères. L’annuaire gratuit vous aide à le trouver ; nos guides expliquent chaque type de vente et chaque étape.",
    links: [
      { href: "/avocats", label: "Trouver un avocat" },
      { href: "/ressources", label: "Lire les guides" },
    ],
  },
] as const;

export default function Page() {
  return (
    <PageShell
      eyebrow="Comment ça marche"
      title="De la recherche à l’enchère, en quatre étapes"
      description="Immojudis rassemble les ventes immobilières aux enchères, les explique et vous aide à préparer votre limite."
      width="narrow"
    >
      <ol className="grid gap-5">
        {STEPS.map((step, index) => (
          <li key={step.title}>
            <Card className="flex gap-4 sm:gap-6">
              <div className="flex flex-col items-center gap-2">
                <span
                  aria-hidden
                  className="grid size-14 place-items-center rounded-full bg-gold/10 text-gold-text sm:size-16"
                >
                  <step.icon className="size-7 sm:size-8" />
                </span>
                <span className="font-display text-lg font-semibold text-gold-text" aria-hidden>
                  {index + 1}
                </span>
              </div>
              <div className="min-w-0">
                <h2 className="font-display text-2xl font-semibold">
                  <span className="sr-only">Étape {index + 1} : </span>
                  {step.title}
                </h2>
                <p className="mt-2 leading-relaxed text-ink-soft">{step.text}</p>
                <div className="mt-4 flex flex-wrap gap-2">
                  {step.links.map((link, linkIndex) => (
                    <Link
                      key={link.href + link.label}
                      href={link.href}
                      className={buttonClasses({
                        variant: linkIndex === 0 ? "primary" : "secondary",
                        size: "sm",
                      })}
                    >
                      {link.label}
                      {linkIndex === 0 ? <ArrowRight className="size-4" aria-hidden /> : null}
                    </Link>
                  ))}
                </div>
              </div>
            </Card>
          </li>
        ))}
      </ol>

      <Card as="section" className="mt-8 bg-surface-muted" aria-labelledby="couverture">
        <h2 id="couverture" className="font-display text-2xl font-semibold">
          Couverture et limites
        </h2>
        <p className="mt-2 text-ink-soft">
          Le catalogue couvre la France entière, mais la couverture varie selon les sources : un
          secteur sans résultat ne prouve pas qu’aucune vente n’y est prévue. Les données et les
          estimations sont des aides à la décision à vérifier dans les pièces officielles ; aucune
          estimation ne garantit le résultat d’une vente.
        </p>
        <Link
          href="/contact"
          className="mt-3 inline-flex min-h-11 items-center font-semibold text-gold-text underline"
        >
          Signaler une information manquante
        </Link>
      </Card>
    </PageShell>
  );
}
