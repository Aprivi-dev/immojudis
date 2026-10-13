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
  title: "Comment ça marche : préparer une vente",
  description:
    "Trouver une vente aux enchères, comprendre le bien, fixer son enchère plafond et se faire accompagner : les quatre étapes d’Immojudis.",
};

const STEPS = [
  {
    icon: Search,
    title: "Repérer une vente",
    text: "Cherchez par ville, département ou région, puis filtrez par type de vente (tribunal, notaire, domaine), budget et surface. Créez une alerte : un email récapitulatif (hebdomadaire avec le compte gratuit, quotidien avec Analyse) vous signale les nouvelles ventes qui vous correspondent, avec la date d’audience et la mise à prix.",
    links: [{ href: "/sales", label: "Ouvrir le catalogue" }],
  },
  {
    icon: FileSearch,
    title: "Étudier et visiter",
    text: "Avec un compte gratuit, la fiche réunit l’adresse, les photos, la description, l’occupation, les visites, les risques de la commune et une fourchette de valeur. L’offre Analyse ajoute les pièces du dossier et les ventes comparables. Lisez le cahier des conditions de vente (le document qui fixe les règles de la vente), visitez le bien et comparez jusqu’à trois biens côte à côte.",
    links: [
      { href: "/annonce-exemple", label: "Voir une fiche exemple" },
      {
        href: "/ressources/lire-cahier-conditions-vente-preparer-visite",
        label: "Lire le cahier et préparer la visite",
      },
    ],
  },
  {
    icon: BadgeEuro,
    title: "Fixer son enchère plafond",
    text: "Avec l’offre Analyse, le simulateur chiffre votre enchère plafond : valeur estimée, marge, travaux, libération du bien, portage (les coûts supportés tant que le bien ne rapporte rien) et tous les frais de la vente, que vous ajustez selon votre projet. Préparez aussi votre financement : il n’y a en principe pas de condition suspensive de prêt dans les ventes judiciaires ; vérifiez le cahier pour les autres ventes. Fixez la limite avant l’audience, puis tenez-vous-y.",
    links: [
      { href: "/annonce-exemple", label: "Essayer le simulateur" },
      { href: "/ressources/frais-vente-encheres-judiciaire", label: "Comprendre les frais" },
      { href: "/offres", label: "Voir les offres" },
    ],
  },
  {
    icon: Scale,
    title: "Enchérir et finaliser",
    text: "Pour une vente au tribunal, un avocat du barreau compétent porte vos enchères ; pour une vente notariale ou domaniale, l’organisateur précise les conditions. Si vous gagnez, le prix et les frais se règlent dans des délais fixés par le Code ou le cahier de vente. L’annuaire est gratuit pour vous ; certains profils sont sponsorisés et identifiés comme tels. Il vous aide à trouver un avocat ; nos guides expliquent chaque étape.",
    links: [
      { href: "/avocats", label: "Trouver un avocat" },
      { href: "/ressources/jour-audience-encheres-role-avocat", label: "Le jour de l’audience" },
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
          estimations sont des aides à la décision à vérifier dans les pièces officielles ;
          Immojudis ne fournit pas de conseil juridique et aucune estimation ne garantit le résultat
          d’une vente ni un gain.
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
