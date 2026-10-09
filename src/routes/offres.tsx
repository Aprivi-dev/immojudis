"use client";

import { useEffect, useState, type ReactNode } from "react";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right.js";
import BadgeEuro from "lucide-react/dist/esm/icons/badge-euro.js";
import Bell from "lucide-react/dist/esm/icons/bell.js";
import Building2 from "lucide-react/dist/esm/icons/building-2.js";
import Check from "lucide-react/dist/esm/icons/check.js";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.js";
import FileText from "lucide-react/dist/esm/icons/file-text.js";
import Minus from "lucide-react/dist/esm/icons/minus.js";
import Scale from "lucide-react/dist/esm/icons/scale.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import Wrench from "lucide-react/dist/esm/icons/wrench.js";
import { BillingActions } from "@/components/BillingActions";
import { Badge, Card, Eyebrow, buttonClasses } from "@/components/ui/primitives";
import { ANALYSIS_TRIAL_DAYS, resolveAnalysisOfferLabel } from "@/lib/analysis-offer";
import { fetchBillingOffer } from "@/lib/client-billing";
import { offerComparisonRows } from "@/lib/offer-comparison";
import { createFileRoute, Link } from "@/lib/router-compat";

export const Route = createFileRoute("/offres")({
  head: () => ({
    meta: [
      { title: "Offres Découverte et Analyse — Immojudis" },
      {
        name: "description",
        content:
          "Découverte est gratuite. Analyse chiffre votre enchère plafond, suit les nouvelles ventes avec des alertes et s’appuie sur des ventes comparables réelles : 29 € TTC par mois.",
      },
    ],
  }),
  component: OffersPage,
});

type OfferState = { configured: boolean | null; trialAvailable: boolean };

/** La souscription peut être fermée côté serveur : la page le dit au lieu de promettre un essai. */
function useOfferState(): OfferState {
  const [state, setState] = useState<OfferState>({ configured: null, trialAvailable: true });
  useEffect(() => {
    let active = true;
    fetchBillingOffer()
      .then((offer) => {
        if (active) {
          setState({
            configured: offer.configured,
            trialAvailable: offer.trialAvailable !== false,
          });
        }
      })
      .catch(() => {
        if (active) setState({ configured: false, trialAvailable: false });
      });
    return () => {
      active = false;
    };
  }, []);
  return state;
}

const BENEFITS = [
  {
    icon: <BadgeEuro className="size-6" aria-hidden />,
    title: "Une enchère plafond chiffrée",
    text: "Valeur estimée, frais, travaux et marge de sécurité : vous voyez d’où vient votre limite et vous l’ajustez selon votre projet.",
  },
  {
    icon: <Bell className="size-6" aria-hidden />,
    title: "Des alertes sur les nouvelles ventes",
    text: "Fixez vos critères une fois : un seul email récapitulatif par jour vous signale les ventes qui correspondent.",
  },
  {
    icon: <Building2 className="size-6" aria-hidden />,
    title: "Des comparables de ventes réelles",
    text: "L’estimation du bien s’appuie sur des ventes comparables réellement conclues autour du bien, avec leur source.",
  },
] as const;

const DISCOVERY_FEATURES = [
  "Catalogue, filtres, photos, mise à prix et date de vente",
  "Sources publiques de la procédure et risques naturels de la commune",
  "Jusqu’à trois favoris et une alerte",
  "Annuaire des avocats par barreau",
] as const;

const ANALYSIS_FEATURES = [
  "Enchère plafond simulée, frais et travaux ajustables",
  "Estimation du bien et ventes comparables",
  "Jusqu’à 25 alertes et zones surveillées",
  "Statistiques des ventes et des tribunaux",
  "Rapport PDF du scénario et export des résultats",
] as const;

const FAQ: { question: string; answer: (state: OfferState) => ReactNode }[] = [
  {
    question: "Comment résilier ?",
    answer: () => (
      <>
        Depuis la page « Mon compte », le bouton « Gérer mon abonnement » ouvre le portail de
        paiement : vous y résiliez à tout moment et vous téléchargez vos factures. La résiliation
        prend effet à la fin de la période payée.
      </>
    ),
  },
  {
    question: "Y a-t-il un essai gratuit ?",
    answer: ({ configured, trialAvailable }) =>
      configured === false ? (
        <>
          Les souscriptions sont fermées pour le moment : aucun essai n’est proposé tant que le
          paiement est indisponible. Le catalogue reste accessible gratuitement avec l’offre
          Découverte.
        </>
      ) : trialAvailable ? (
        <>
          Oui. L’offre Analyse démarre par un essai de {ANALYSIS_TRIAL_DAYS} jours avec carte
          bancaire. Sans résiliation avant la fin de l’essai, l’abonnement se poursuit au tarif
          affiché ({resolveAnalysisOfferLabel()}). L’essai n’est proposé qu’une fois par compte.
        </>
      ) : (
        <>
          L’essai gratuit n’est proposé qu’une fois par compte. Vous pouvez souscrire directement à
          l’offre Analyse au tarif affiché ({resolveAnalysisOfferLabel()}).
        </>
      ),
  },
  {
    question: "Puis-je être remboursé ?",
    answer: () => (
      <>
        Vous disposez d’un délai de rétractation de 14 jours. Si vous demandez l’exécution immédiate
        du service, un montant proportionnel au service déjà fourni peut rester dû. Les règles
        complètes figurent dans les{" "}
        <Link href="/conditions-generales" className="font-semibold text-gold-text underline">
          conditions générales
        </Link>
        .
      </>
    ),
  },
  {
    question: "Quelle est la couverture géographique ?",
    answer: () => (
      <>
        Le catalogue couvre la France entière. La couverture varie selon les sources : certaines
        régions comptent plus d’annonces que d’autres, et une donnée absente ne signifie pas
        l’absence de risque. La page{" "}
        <Link href="/comment-ca-marche" className="font-semibold text-gold-text underline">
          Comment ça marche
        </Link>{" "}
        détaille les limites.
      </>
    ),
  },
  {
    question: "En quoi est-ce différent d’un avocat ?",
    answer: () => (
      <>
        Immojudis est un outil d’information et d’aide à la décision : il ne donne pas de conseil
        juridique et ne vous représente pas. Pour enchérir à une vente au tribunal, un avocat du
        barreau compétent est nécessaire ; l’{" "}
        <Link href="/avocats" className="font-semibold text-gold-text underline">
          annuaire des avocats
        </Link>{" "}
        est gratuit.
      </>
    ),
  },
];

export function OffersPage() {
  const offer = useOfferState();
  const price = resolveAnalysisOfferLabel();
  const trialLine =
    offer.configured === null
      ? null
      : offer.configured === false
        ? "Les souscriptions ne sont pas ouvertes pour le moment. Le catalogue reste accessible gratuitement."
        : offer.trialAvailable
          ? `Essai gratuit de ${ANALYSIS_TRIAL_DAYS} jours avec carte bancaire, puis abonnement résiliable à tout moment.`
          : "Abonnement résiliable à tout moment, sans nouvel essai.";

  return (
    <main id="contenu" className="min-h-screen bg-white text-brand-navy">
      <section className="border-b border-brand-navy/10 bg-background">
        <div className="mx-auto grid max-w-[1460px] gap-10 px-4 py-10 sm:px-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(500px,0.85fr)] lg:items-center lg:px-8 lg:py-12">
          <div>
            <Eyebrow className="mb-4">Offres</Eyebrow>
            <h1 className="max-w-3xl font-display text-[clamp(2.6rem,4.5vw,4.5rem)] font-medium leading-[0.98] text-brand-navy">
              La mise à prix est un départ. Préparez votre limite avant l’enchère.
            </h1>
            <p className="mt-6 max-w-2xl text-base leading-relaxed text-ink-soft sm:text-lg">
              Immojudis réunit les comparables disponibles, les frais et les travaux pour vous aider
              à fixer une limite selon votre projet et vos hypothèses.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link
                href="/annonce-exemple"
                className={buttonClasses({ variant: "primary", size: "lg" })}
              >
                Voir une analyse exemple
                <ArrowRight className="size-4" aria-hidden />
              </Link>
              <Link to="/sales" className={buttonClasses({ size: "lg" })}>
                Explorer gratuitement
              </Link>
            </div>
          </div>
          <DecisionEquation />
        </div>
      </section>

      <section
        aria-labelledby="benefices"
        className="mx-auto max-w-[1220px] px-4 pt-12 sm:px-6 lg:px-8"
      >
        <h2 id="benefices" className="sr-only">
          Ce que l’offre Analyse apporte
        </h2>
        <ul className="grid gap-4 md:grid-cols-3">
          {BENEFITS.map((benefit) => (
            <li key={benefit.title}>
              <Card className="h-full">
                <span className="text-gold-text">{benefit.icon}</span>
                <h3 className="mt-3 font-display text-2xl font-semibold leading-tight">
                  {benefit.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-ink-soft">{benefit.text}</p>
              </Card>
            </li>
          ))}
        </ul>
      </section>

      <section
        aria-labelledby="tarifs"
        className="mx-auto max-w-[1220px] px-4 py-12 sm:px-6 lg:px-8"
      >
        <h2 id="tarifs" className="font-display text-3xl font-medium sm:text-4xl">
          Deux offres, un prix clair
        </h2>
        <p className="mt-2 max-w-3xl text-ink-soft">
          Découverte est gratuite, sans limite de durée. Analyse coûte {price}, résiliable à tout
          moment.
        </p>
        <div className="mt-6 grid gap-5 lg:grid-cols-2">
          <PlanPanel
            name="Découverte"
            price="0 €"
            description="Pour repérer les ventes et conserver vos favoris."
            features={DISCOVERY_FEATURES}
          >
            <Link
              to="/login"
              search={{ mode: "investor", redirect: "/sales" }}
              className={buttonClasses({ size: "lg", className: "w-full" })}
            >
              Créer mon compte gratuit
            </Link>
          </PlanPanel>

          <PlanPanel
            name="Analyse"
            price={price}
            description="Pour décider, chiffrer et préparer l’enchère."
            features={ANALYSIS_FEATURES}
            highlighted
          >
            {trialLine ? <p className="mb-4 text-center text-sm font-medium">{trialLine}</p> : null}
            <BillingActions hideHelper className="[&>button]:w-full" />
          </PlanPanel>
        </div>
      </section>

      <section
        aria-labelledby="comparatif"
        className="border-t border-brand-navy/10 bg-surface-muted"
      >
        <div className="mx-auto max-w-[1220px] px-4 py-12 sm:px-6 lg:px-8 lg:py-16">
          <h2 id="comparatif" className="font-display text-3xl font-medium sm:text-4xl">
            Comparer les deux offres
          </h2>
          <ComparisonTable />
          <p className="mt-4 text-sm text-ink-soft">
            Les analyses dépendent des informations et des pièces disponibles pour chaque vente.
            Vérifiez le contenu de la fiche avant de décider.
          </p>
        </div>
      </section>

      <section aria-labelledby="faq" className="mx-auto max-w-[900px] px-4 py-12 sm:px-6 lg:py-16">
        <h2 id="faq" className="font-display text-3xl font-medium sm:text-4xl">
          Questions fréquentes
        </h2>
        <div className="mt-6 divide-y divide-line border-y border-line">
          {FAQ.map((item) => (
            <details key={item.question} className="group py-4">
              <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold">
                {item.question}
                <ChevronDown
                  className="size-5 shrink-0 transition-transform group-open:rotate-180"
                  aria-hidden
                />
              </summary>
              <div className="mt-2 text-sm leading-relaxed text-ink-soft">{item.answer(offer)}</div>
            </details>
          ))}
        </div>
        <p className="mt-8 flex items-start gap-3 text-sm text-ink-soft">
          <Scale className="mt-0.5 size-4 shrink-0 text-gold-text" aria-hidden />
          Les estimations et simulations sont des aides à la décision : elles ne constituent ni une
          expertise, ni un conseil juridique ou financier.
        </p>
      </section>
    </main>
  );
}

function ComparisonTable() {
  const rows = offerComparisonRows();
  return (
    <div className="mt-6 overflow-hidden rounded-xl border border-line bg-white">
      <table className="w-full table-fixed border-collapse text-left text-sm">
        <caption className="sr-only">Comparaison des offres Découverte et Analyse</caption>
        <thead className="bg-surface-tint">
          <tr>
            <th scope="col" className="w-[40%] px-3 py-3 font-semibold sm:px-4">
              Fonctionnalité
            </th>
            <th scope="col" className="px-3 py-3 font-semibold sm:px-4">
              Découverte
            </th>
            <th scope="col" className="px-3 py-3 font-semibold sm:px-4">
              Analyse
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line-soft">
          {rows.map((row) => (
            <tr key={row.id}>
              <th scope="row" className="px-3 py-3 align-top font-medium sm:px-4">
                {row.label}
                {row.hint ? (
                  <span className="mt-0.5 block text-xs font-normal text-ink-soft">{row.hint}</span>
                ) : null}
              </th>
              <ComparisonCell cell={row.decouverte} />
              <ComparisonCell cell={row.analyse} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ComparisonCell({ cell }: { cell: { included: boolean; text: string } }) {
  return (
    <td className="px-3 py-3 align-top sm:px-4">
      <span className="flex items-start gap-2">
        {cell.included ? (
          <Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
        ) : (
          <Minus className="mt-0.5 size-4 shrink-0 text-ink-soft" aria-hidden />
        )}
        <span className={cell.included ? "" : "text-ink-soft"}>{cell.text}</span>
      </span>
    </td>
  );
}

function DecisionEquation() {
  const items = [
    { icon: <Building2 className="size-7" />, label: "Valeur estimée", sign: "−" },
    { icon: <ShieldCheck className="size-7" />, label: "Marge de sécurité", sign: "−" },
    { icon: <FileText className="size-7" />, label: "Frais", sign: "−" },
    {
      icon: <Wrench className="size-7" />,
      label: "Travaux inclus par défaut",
      sign: "=",
      accent: true,
    },
    { icon: <BadgeEuro className="size-8" />, label: "Enchère plafond simulée", result: true },
  ];

  return (
    <div>
      <p className="sr-only">
        Enchère plafond = valeur estimée moins marge de sécurité moins frais et travaux.
      </p>
      <div className="grid grid-cols-5 items-start gap-2" aria-hidden>
        {items.map((item) => (
          <div key={item.label} className="relative text-center">
            <span
              className={`mx-auto grid size-14 place-items-center rounded-full border sm:size-16 ${
                item.result
                  ? "border-brand-navy bg-brand-navy text-white"
                  : "border-white bg-white text-brand-navy shadow-sm"
              }`}
            >
              {item.icon}
            </span>
            <p
              className={`mt-3 text-xs font-semibold leading-tight sm:text-sm ${
                item.accent ? "text-gold-text" : "text-brand-navy"
              }`}
            >
              {item.label}
            </p>
            {item.sign ? (
              <span className="absolute -right-2 top-4 text-2xl font-semibold text-gold-text">
                {item.sign}
              </span>
            ) : null}
          </div>
        ))}
      </div>
      <div className="mt-7 border-t border-gold pt-6 text-center">
        <p className="text-sm font-medium leading-relaxed sm:text-base">
          Schéma indicatif : ajustez les frais et les travaux selon les pièces disponibles et la
          visite du bien.
        </p>
      </div>
    </div>
  );
}

function PlanPanel({
  name,
  price,
  description,
  features,
  children,
  highlighted = false,
}: {
  name: string;
  price: string;
  description: string;
  features: readonly string[];
  children: ReactNode;
  highlighted?: boolean;
}) {
  return (
    <Card
      as="article"
      padded={false}
      aria-labelledby={`offre-${name}`}
      className={`flex flex-col overflow-hidden ${highlighted ? "border-brand-navy" : ""}`}
    >
      <div
        className={
          highlighted
            ? "flex items-center justify-between bg-brand-navy px-6 py-4 text-white"
            : "px-6 pt-5"
        }
      >
        <h3 id={`offre-${name}`} className="font-display text-3xl font-semibold">
          {name}
        </h3>
        {highlighted ? (
          <Badge tone="gold" className="!border-gold-light !bg-transparent !text-gold-light">
            Recommandée
          </Badge>
        ) : null}
      </div>
      <div className="flex flex-1 flex-col p-6 sm:p-8">
        <div>
          <strong className="font-display text-5xl font-medium leading-none sm:text-6xl">
            {price}
          </strong>
          <p className="mt-3 text-sm text-ink-soft">{description}</p>
        </div>
        <ul className="my-6 grid gap-3">
          {features.map((feature) => (
            <li key={feature} className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-3 text-sm">
              <Check className="mt-0.5 size-4 text-success" aria-hidden />
              <span className="leading-relaxed">{feature}</span>
            </li>
          ))}
        </ul>
        <div className="mt-auto">{children}</div>
      </div>
    </Card>
  );
}
