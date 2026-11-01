import type { Metadata } from "next";
import Link from "next/link";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right.js";
import BadgeEuro from "lucide-react/dist/esm/icons/badge-euro.js";
import Search from "lucide-react/dist/esm/icons/search.js";
import UserPlus from "lucide-react/dist/esm/icons/user-plus.js";
import { Card, PageShell, buttonClasses } from "@/components/ui/primitives";
import { BreadcrumbJsonLd } from "@/components/BreadcrumbJsonLd";
import { LaunchOfferNote } from "@/components/LaunchOfferNote";
import { loginPathWithRedirect } from "@/lib/navigation";
import { MONTHLY_SALE_UNLOCKS } from "@/lib/sale-unlocks";
import { pageMetadata } from "@/lib/page-metadata";

export const metadata: Metadata = pageMetadata({
  path: "/comment-ca-marche",
  title: "Comment ça marche : préparer une vente",
  description:
    "Créer son compte, repérer une vente aux enchères, fixer son enchère plafond et se faire accompagner : les trois étapes d’Immojudis.",
});

const STEPS = [
  {
    icon: UserPlus,
    title: "Créez votre compte gratuit",
    text: `Le compte Découverte est gratuit et ne demande pas de carte bancaire. Il ouvre la fiche de chaque vente (adresse, photos, description, occupation, visites, risques de la commune et fourchette de valeur) et les alertes par email : un récapitulatif hebdomadaire avec le compte gratuit, quotidien avec l’offre Analyse. Les pièces du dossier s’ouvrent vente par vente avec les déblocages mensuels du compte gratuit (${MONTHLY_SALE_UNLOCKS} ventes par mois), et pour toutes les ventes avec l’offre Analyse, qui ajoute aussi les ventes comparables.`,
    links: [
      { href: loginPathWithRedirect(undefined), label: "Créer mon compte gratuit" },
      { href: "/offres", label: "Voir les offres" },
    ],
  },
  {
    icon: Search,
    title: "Repérez vos ventes",
    text: "Cherchez par ville, département ou région, puis filtrez par type de vente (tribunal, notaire, domaine), budget et surface. Enregistrez une alerte sur votre secteur : elle vous signale les nouvelles ventes qui vous correspondent, avec la date d’audience et la mise à prix. Lisez ensuite le cahier des conditions de vente (le document qui fixe les règles de la vente), visitez le bien et comparez jusqu’à trois biens côte à côte.",
    links: [
      { href: "/sales", label: "Ouvrir le catalogue" },
      { href: "/annonce-exemple", label: "Voir une fiche exemple" },
      {
        href: "/ressources/lire-cahier-conditions-vente-preparer-visite",
        label: "Lire le cahier et préparer la visite",
      },
    ],
  },
  {
    icon: BadgeEuro,
    title: "Fixez votre plafond",
    text: `Le simulateur chiffre votre enchère plafond : valeur estimée, marge, travaux, libération du bien, portage (les coûts supportés tant que le bien ne rapporte rien) et tous les frais de la vente, que vous ajustez selon votre projet. Le compte gratuit l’ouvre sur ${MONTHLY_SALE_UNLOCKS} ventes au tribunal par mois (déblocages) ; l’offre Analyse l’ouvre sur toutes les ventes au tribunal. Fixez la limite avant l’audience, puis tenez-vous-y. Pour une vente au tribunal, un avocat du barreau compétent porte vos enchères ; pour une vente notariale ou domaniale, l’organisateur précise les conditions. Si vous gagnez, le prix et les frais se règlent dans des délais fixés par le Code ou le cahier de vente.`,
    links: [
      { href: "/annonce-exemple", label: "Essayer le simulateur" },
      { href: "/simulateur-frais-encheres", label: "Simuler les frais" },
      { href: "/avocats", label: "Trouver un avocat" },
      { href: "/ressources/jour-audience-encheres-role-avocat", label: "Le jour de l’audience" },
    ],
  },
] as const;

/** Ce qui surprend le plus souvent un débutant : quatre règles de la vente au tribunal, avec leur guide. */
const SURPRISES = [
  {
    title: "Une garantie à remettre avant l’audience",
    text: "L’avocat qui porte vos enchères se fait remettre un chèque de banque ou une caution bancaire de 10 % de la mise à prix, avec un minimum de 3 000 € (art. R. 322-41 du Code des procédures civiles d’exécution).",
    href: "/ressources/garantie-10-pourcent-cheque-banque-caution-encheres",
    label: "Le guide de la garantie",
  },
  {
    title: "Des frais en plus du prix",
    text: "Les frais de poursuite taxés par le juge, les droits de mutation et les émoluments des avocats s’ajoutent au prix d’adjudication (art. R. 322-58 du Code des procédures civiles d’exécution pour les frais taxés et les droits de mutation ; art. A. 444-191 du Code de commerce pour les émoluments).",
    href: "/ressources/frais-vente-encheres-judiciaire",
    label: "Le guide des frais",
  },
  {
    title: "Pas de condition suspensive de prêt",
    text: "En principe, la vente au tribunal ne prévoit pas de sortie en cas de refus de prêt : le prix et les frais se paient dans les deux mois de l’adjudication définitive, sinon le bien est remis en vente.",
    href: "/ressources/financer-achat-encheres-pret-delais",
    label: "Le guide du financement",
  },
  {
    title: "Une surenchère possible pendant dix jours",
    text: "Après l’adjudication, toute personne peut faire une offre supérieure d’au moins un dixième du prix principal : l’achat n’est définitif qu’à l’issue de ce délai (art. R. 322-50 et R. 322-51).",
    href: "/ressources/apres-adjudication-surenchere-paiement-titre-vente",
    label: "Le guide après l’adjudication",
  },
] as const;

export default function Page() {
  return (
    <>
      <BreadcrumbJsonLd trail={[{ name: "Comment ça marche", path: "/comment-ca-marche" }]} />
      <PageContent />
    </>
  );
}

function PageContent() {
  return (
    <PageShell
      eyebrow="Comment ça marche"
      title="De l’annonce à l’audience, en trois étapes"
      description="Immojudis rassemble les ventes immobilières aux enchères, les explique et vous aide à préparer votre limite."
      width="narrow"
    >
      <LaunchOfferNote className="mb-5" />
      <ol className="grid gap-5" aria-label="Les trois étapes">
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

      <Card as="section" className="mt-8" aria-labelledby="surprises">
        <h2 id="surprises" className="font-display text-2xl font-semibold">
          Ce qui surprend les débutants
        </h2>
        <p className="mt-2 text-ink-soft">
          Quatre règles de la vente au tribunal que l’on découvre souvent trop tard. Elles valent
          pour la saisie immobilière ; pour une vente notariale ou domaniale, le cahier des charges
          fait foi.
        </p>
        <ul className="mt-4 grid gap-4" aria-label="Ce qui surprend les débutants">
          {SURPRISES.map((item) => (
            <li key={item.title}>
              <h3 className="font-semibold">{item.title}</h3>
              <p className="mt-1 leading-relaxed text-ink-soft">{item.text}</p>
              <Link
                href={item.href}
                className="mt-1 inline-flex min-h-11 items-center font-semibold text-gold-text underline"
              >
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
      </Card>

      <Card
        as="aside"
        className="mt-8 bg-surface-muted"
        aria-labelledby="note-annuaire"
        data-testid="note-annuaire-avocats"
      >
        <h2 id="note-annuaire" className="font-display text-xl font-semibold">
          Note sur l’annuaire d’avocats
        </h2>
        <p className="mt-2 text-ink-soft">
          La consultation de l’annuaire est gratuite. Certains avocats rémunèrent Immojudis pour une
          mise en avant payante, signalée comme telle. La demande de mise en relation depuis une
          annonce fait partie de l’offre Analyse. Le choix de votre avocat vous appartient.
        </p>
      </Card>

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
