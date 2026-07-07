import { createFileRoute, Link } from "@/lib/router-compat";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right.js";
import BellRing from "lucide-react/dist/esm/icons/bell-ring.js";
import Calculator from "lucide-react/dist/esm/icons/calculator.js";
import Check from "lucide-react/dist/esm/icons/check.js";
import Database from "lucide-react/dist/esm/icons/database.js";
import Download from "lucide-react/dist/esm/icons/download.js";
import FileChartColumnIncreasing from "lucide-react/dist/esm/icons/file-chart-column-increasing.js";
import FileSearch from "lucide-react/dist/esm/icons/file-search.js";
import Gauge from "lucide-react/dist/esm/icons/gauge.js";
import LockKeyhole from "lucide-react/dist/esm/icons/lock-keyhole.js";
import NotebookPen from "lucide-react/dist/esm/icons/notebook-pen.js";
import Radar from "lucide-react/dist/esm/icons/radar.js";
import Scale from "lucide-react/dist/esm/icons/scale.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import Sparkles from "lucide-react/dist/esm/icons/sparkles.js";
import Star from "lucide-react/dist/esm/icons/star.js";
import UsersRound from "lucide-react/dist/esm/icons/users-round.js";
import X from "lucide-react/dist/esm/icons/x.js";
import type { ComponentType } from "react";
import { ApiKeyManager } from "@/components/ApiKeyManager";
import { BillingActions } from "@/components/BillingActions";

export const Route = createFileRoute("/accompagnement")({
  head: () => ({
    meta: [
      { title: "Offre Pro — Immojudis" },
      {
        name: "description",
        content:
          "Offre Immojudis Pro : rapports d'opportunité, comparables DVF, calcul de mise maximale, alertes avancées, suivi d'audience et avocats référencés.",
      },
    ],
  }),
  component: AccompagnementPage,
});

type IconComponent = ComponentType<{ className?: string; "aria-hidden"?: boolean }>;

const productModules = [
  {
    icon: FileChartColumnIncreasing,
    title: "Rapports d'opportunité",
    text: "Mise à prix, estimation basse-médiane-haute, ventes comparables DVF, prix moyen local, décote apparente et score de confiance.",
  },
  {
    icon: Calculator,
    title: "Mise maximale conseillée",
    text: "Budget, frais, travaux, rendement ou marge cible : le plafond d'enchère devient une limite chiffrée avant l'audience.",
  },
  {
    icon: BellRing,
    title: "Alertes intelligentes",
    text: "Signaux par zone, type de bien, DPE, décote minimale, rendement potentiel, maison avec terrain ou nouvelle audience proche.",
  },
  {
    icon: NotebookPen,
    title: "Suivi investisseur",
    text: "Favoris, notes privées, checklist avant enchère, suivi d'audience, documents centralisés et export PDF partageable.",
  },
  {
    icon: UsersRound,
    title: "Avocats référencés",
    text: "Mise en relation avec des avocats référencés par barreau, tribunal et zone d'intervention pour porter l'enchère.",
  },
] satisfies Array<{ icon: IconComponent; title: string; text: string }>;

const plans = [
  {
    planCode: "analyse",
    icon: ShieldCheck,
    name: "ImmoJudis Pro",
    price: "29 à 79 €/mois",
    audience:
      "Pour les acheteurs actifs, investisseurs particuliers et professionnels qui suivent quelques dossiers à la fois.",
    features: [
      "Rapports complets sur les annonces suivies",
      "Comparables DVF détaillés et prix/m² local",
      "Calcul de mise maximale, frais et travaux estimés",
      "Mise en relation avec des avocats référencés",
      "Alertes avancées, favoris, notes et export PDF",
      "Checklist avant audience et points à valider avec l'avocat",
    ],
  },
  {
    planCode: "investisseur",
    icon: UsersRound,
    name: "ImmoJudis Investisseur",
    price: "99 à 199 €/mois",
    audience:
      "Pour marchands de biens, chasseurs, foncières locales et équipes qui comparent plusieurs ventes.",
    features: [
      "Alertes temps réel et zones surveillées",
      "Scoring de rentabilité et analyse multi-biens",
      "Exports CSV, historique des ventes passées et accès API léger",
      "Documents centralisés et annotation collaborative",
      "Pilotage des demandes avocat sur plusieurs dossiers",
      "Quotas de rapports plus élevés et suivi de portefeuille",
    ],
  },
] satisfies Array<{
  planCode: "analyse" | "investisseur";
  icon: IconComponent;
  name: string;
  price: string;
  audience: string;
  features: string[];
}>;

const reportScope = [
  { label: "Marché", value: "DVF, prix/m², rayon 300 m à 2 km, ventes < 36 mois" },
  { label: "Dossier", value: "tribunal, audience, mise à prix, occupation, documents, frais" },
  { label: "Risque", value: "DPE, parcelle cadastrale, points juridiques, données manquantes" },
  { label: "Décision", value: "score d'opportunité, score de confiance, plafond conseillé" },
  { label: "Avocats", value: "barreau compétent, disponibilité, demande de mise en relation" },
] as const;

const implementationSteps = [
  "V1 robuste sans IA avancée : règles de comparables, pondération récence-distance et niveau de confiance.",
  "Pipeline data : import ventes judiciaires, DVF semestriel, géocodage BAN, cadastre et DPE à la demande.",
  "Réseau avocats : fiches référencées par barreau, zones couvertes, disponibilité et demande tracée.",
  "Monétisation : quotas de rapports, paywall, PDF watermark gratuit, logs d'usage et plans Stripe.",
] as const;

type ComparisonValue = boolean | "limited" | string;

const comparisonSections = [
  {
    title: "Explorateur de ventes",
    rows: [
      { feature: "Filtres de recherche", discovery: true, analysis: true },
      { feature: "Statistiques des ventes judiciaires", discovery: false, analysis: true },
      { feature: "Alertes email simples", discovery: true, analysis: true },
    ],
  },
  {
    title: "Rapport d'opportunité judiciaire",
    rows: [
      { feature: "Estimation de valeur", discovery: true, analysis: true },
      { feature: "Comparables DVF détaillés", discovery: "limited", analysis: true },
      { feature: "Décote apparente vs mise à prix", discovery: true, analysis: true },
      { feature: "Score d'opportunité et niveau de confiance", discovery: false, analysis: true },
      { feature: "Frais d'adjudication estimés", discovery: "limited", analysis: true },
      { feature: "Risques, occupation et points juridiques", discovery: false, analysis: true },
      { feature: "Export PDF du rapport", discovery: "limited", analysis: true },
      { feature: "Édition du rapport et notes privées", discovery: "limited", analysis: true },
    ],
  },
  {
    title: "Moteur d'enchère",
    rows: [
      { feature: "Calcul de mise maximale", discovery: true, analysis: true },
      { feature: "Scénarios frais, travaux et marge cible", discovery: false, analysis: true },
      { feature: "Rentabilité brute potentielle", discovery: false, analysis: true },
      { feature: "Checklist avant audience", discovery: true, analysis: true },
    ],
  },
  {
    title: "Alertes intelligentes",
    rows: [
      { feature: "Alerte par ville, budget et type de bien", discovery: true, analysis: true },
      { feature: "Alerte décote minimale", discovery: false, analysis: true },
      { feature: "Alerte rendement, DPE ou maison avec terrain", discovery: false, analysis: true },
      { feature: "Zones surveillées et suivi multi-biens", discovery: false, analysis: true },
    ],
  },
  {
    title: "Avocats référencés",
    rows: [
      { feature: "Identification du barreau compétent", discovery: true, analysis: true },
      {
        feature: "Annuaire d'avocats référencés par tribunal",
        discovery: "limited",
        analysis: true,
      },
      { feature: "Demande de mise en relation", discovery: false, analysis: true },
      {
        feature: "Suivi de prise de contact et pièces à transmettre",
        discovery: false,
        analysis: true,
      },
    ],
  },
  {
    title: "Données et exports avancés",
    rows: [
      { feature: "Analyse cadastrale et DPE", discovery: "limited", analysis: true },
      { feature: "Historique des ventes passées", discovery: false, analysis: true },
      { feature: "Exports CSV", discovery: false, analysis: true },
      { feature: "Accès API léger", discovery: false, analysis: true },
    ],
  },
] satisfies Array<{
  title: string;
  rows: Array<{ feature: string; discovery: ComparisonValue; analysis: ComparisonValue }>;
}>;

function AccompagnementPage() {
  return (
    <main className="liquid-page min-h-screen text-foreground">
      <section className="mx-auto grid max-w-6xl gap-8 px-4 py-12 sm:px-6 lg:grid-cols-[minmax(0,1fr)_25rem] lg:items-center lg:py-16">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-gold/25 bg-white/70 px-3 py-2 text-[11px] font-bold uppercase tracking-[0.18em] text-gold-soft shadow-sm">
            <ShieldCheck className="h-4 w-4" />
            Offre ImmoJudis Pro
          </div>
          <h1 className="mt-5 max-w-4xl font-display text-4xl leading-none text-foreground sm:text-6xl">
            L'espace de décision pour enchères immobilières judiciaires.
          </h1>
          <p className="mt-5 max-w-2xl text-base leading-relaxed text-muted-foreground sm:text-lg">
            ImmoJudis Pro transforme les annonces judiciaires en rapports exploitables : valeur de
            marché, comparables, risques, frais, rentabilité, mise maximale et accès à des avocats
            référencés avant audience.
          </p>
          <div className="mt-7 flex flex-col gap-3 sm:flex-row">
            <BillingActions />
            <Link to="/sales" className="ij-signup-button gap-2 px-5 py-3 text-sm font-bold">
              Explorer les ventes <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </div>

        <aside className="rounded-lg border border-white/70 bg-white/85 p-5 shadow-[0_1.6rem_4rem_rgb(72_104_132_/_14%)] backdrop-blur">
          <div className="flex items-center justify-between gap-4 border-b border-border pb-4">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-gold-soft">
                Rapport type
              </p>
              <h2 className="mt-1 text-xl font-bold text-foreground">Audience J-12</h2>
            </div>
            <Gauge className="h-7 w-7 text-gold" />
          </div>
          <div className="mt-5 grid grid-cols-2 gap-3">
            <Metric label="Décote" value="-31 %" />
            <Metric label="Score" value="78/100" />
            <Metric label="DVF" value="9 ventes" />
            <Metric label="Plafond" value="126 k€" />
          </div>
          <div className="mt-5 rounded-lg border border-[#1e40af]/15 bg-[#1e40af]/8 p-4 text-sm leading-relaxed text-[#1e3a8a]">
            Données utiles, limites visibles : DVF peut être décalé, les surfaces doivent être
            recoupées et le conseil juridique reste du ressort de l'avocat.
          </div>
        </aside>
      </section>

      <section className="mx-auto max-w-6xl px-4 pb-10 sm:px-6">
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
          {productModules.map((module) => (
            <FeatureCard key={module.title} {...module} />
          ))}
        </div>
      </section>

      <OfferComparisonTable />

      <section className="mx-auto max-w-6xl px-4 pb-10 sm:px-6">
        <div className="mb-5 max-w-3xl">
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-gold-soft">
            Plans recommandés
          </p>
          <h2 className="mt-2 font-display text-3xl leading-tight text-foreground sm:text-4xl">
            Une offre payante centrée sur le moment de décision.
          </h2>
        </div>
        <div className="grid gap-5 lg:grid-cols-2">
          {plans.map((plan) => (
            <PlanCard key={plan.name} {...plan} />
          ))}
        </div>
      </section>

      <ApiKeyManager />

      <section className="mx-auto grid max-w-6xl gap-5 px-4 pb-16 sm:px-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="rounded-lg border border-border bg-white/88 p-5 shadow-sm">
          <div className="flex items-center gap-3">
            <Database className="h-5 w-5 text-gold" />
            <h2 className="font-display text-3xl leading-tight text-foreground">
              Ce que le rapport doit prouver
            </h2>
          </div>
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            {reportScope.map((item) => (
              <div key={item.label} className="rounded-lg border border-border bg-white p-4">
                <p className="text-xs font-bold uppercase tracking-[0.14em] text-gold-soft">
                  {item.label}
                </p>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{item.value}</p>
              </div>
            ))}
          </div>
        </div>

        <aside className="rounded-lg border border-[#132238]/10 bg-[#132238] p-5 text-white shadow-[0_1.4rem_3rem_rgb(19_34_56_/_18%)]">
          <div className="flex items-center gap-3">
            <LockKeyhole className="h-5 w-5 text-[#fbbf24]" />
            <h2 className="text-lg font-bold">Cadre V1</h2>
          </div>
          <ol className="mt-5 grid gap-4">
            {implementationSteps.map((step, index) => (
              <li key={step} className="grid grid-cols-[2rem_minmax(0,1fr)] gap-3">
                <span className="grid h-8 w-8 place-items-center rounded-full bg-white/10 text-sm font-bold">
                  {index + 1}
                </span>
                <span className="text-sm leading-relaxed text-white/72">{step}</span>
              </li>
            ))}
          </ol>
        </aside>
      </section>
    </main>
  );
}

function OfferComparisonTable() {
  return (
    <section className="mx-auto max-w-6xl px-4 pb-10 sm:px-6" aria-labelledby="offer-matrix-title">
      <div className="mb-5 max-w-3xl">
        <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-gold-soft">
          Matrice fonctionnelle
        </p>
        <h2
          id="offer-matrix-title"
          className="mt-2 font-display text-3xl leading-tight text-foreground sm:text-4xl"
        >
          Deux niveaux d'accès, une même logique de décision.
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground sm:text-base">
          Découverte donne les repères essentiels. Analyse débloque les preuves détaillées, les
          exports, les alertes avancées et la mise en relation avocat.
        </p>
      </div>

      <div className="overflow-hidden rounded-lg border border-border bg-white/94 shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[46rem] border-collapse text-left">
            <caption className="sr-only">
              Comparaison des offres ImmoJudis Découverte et Analyse
            </caption>
            <thead>
              <tr className="border-b border-border bg-white">
                <th className="w-[44%] px-5 py-5 text-sm font-semibold text-muted-foreground">
                  Fonctionnalités
                </th>
                <PlanHeading icon={Star} label="Découverte" />
                <PlanHeading icon={Sparkles} label="Analyse" />
              </tr>
            </thead>
            <tbody>
              {comparisonSections.map((section) => (
                <TableSection key={section.title} section={section} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function PlanHeading({ icon: Icon, label }: { icon: IconComponent; label: string }) {
  return (
    <th className="w-[28%] px-5 py-5 text-center text-base font-bold text-foreground">
      <span className="inline-flex items-center justify-center gap-2">
        <Icon className="h-4 w-4 fill-[#5b65ff] text-[#5b65ff]" />
        {label}
      </span>
    </th>
  );
}

function TableSection({ section }: { section: (typeof comparisonSections)[number] }) {
  return (
    <>
      <tr>
        <th
          colSpan={3}
          className="border-b border-t border-border bg-slate-50 px-5 py-3 text-sm font-extrabold text-foreground"
        >
          {section.title}
        </th>
      </tr>
      {section.rows.map((row) => (
        <tr key={row.feature} className="border-b border-border last:border-b-0">
          <th className="px-5 py-4 text-sm font-medium leading-relaxed text-muted-foreground">
            {row.feature}
          </th>
          <ComparisonCell value={row.discovery} />
          <ComparisonCell value={row.analysis} />
        </tr>
      ))}
    </>
  );
}

function ComparisonCell({ value }: { value: ComparisonValue }) {
  if (value === true) {
    return (
      <td className="px-5 py-4 text-center">
        <Check className="mx-auto h-6 w-6 text-[#5b65ff]" aria-label="Inclus" />
      </td>
    );
  }

  if (value === false) {
    return (
      <td className="px-5 py-4 text-center">
        <X className="mx-auto h-5 w-5 text-slate-300" aria-label="Non inclus" />
      </td>
    );
  }

  return (
    <td className="px-5 py-4 text-center text-sm font-medium text-muted-foreground">
      {value === "limited" ? "Limité" : value}
    </td>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-white p-3">
      <span className="block text-[11px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </span>
      <strong className="mt-1 block text-xl font-extrabold text-foreground">{value}</strong>
    </div>
  );
}

function FeatureCard({
  icon: Icon,
  title,
  text,
}: {
  icon: IconComponent;
  title: string;
  text: string;
}) {
  return (
    <article className="rounded-lg border border-border bg-white/86 p-5 shadow-sm backdrop-blur">
      <Icon className="h-5 w-5 text-gold" />
      <h2 className="mt-4 text-base font-extrabold text-foreground">{title}</h2>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{text}</p>
    </article>
  );
}

function PlanCard({
  icon: Icon,
  name,
  price,
  audience,
  features,
  planCode,
}: {
  planCode: "analyse" | "investisseur";
  icon: IconComponent;
  name: string;
  price: string;
  audience: string;
  features: string[];
}) {
  return (
    <article className="rounded-lg border border-border bg-white/90 p-5 shadow-sm backdrop-blur">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full bg-gold/10 px-3 py-1 text-xs font-bold uppercase tracking-[0.12em] text-gold-soft">
            <Icon className="h-4 w-4" />
            {name}
          </div>
          <strong className="mt-4 block font-display text-4xl font-medium leading-none text-foreground">
            {price}
          </strong>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{audience}</p>
        </div>
        <Scale className="hidden h-6 w-6 shrink-0 text-gold sm:block" />
      </div>
      <ul className="mt-5 grid gap-3">
        {features.map((feature) => (
          <li key={feature} className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-2 text-sm">
            <Check className="mt-0.5 h-4 w-4 text-[#166534]" />
            <span className="leading-relaxed text-foreground/78">{feature}</span>
          </li>
        ))}
      </ul>
      <div className="mt-5 flex flex-wrap gap-2 border-t border-border pt-4 text-xs font-bold uppercase tracking-[0.12em] text-muted-foreground">
        <span className="inline-flex items-center gap-1 rounded-full bg-white px-3 py-1">
          <Download className="h-3.5 w-3.5" />
          Export
        </span>
        <span className="inline-flex items-center gap-1 rounded-full bg-white px-3 py-1">
          <Radar className="h-3.5 w-3.5" />
          Alertes
        </span>
        <span className="inline-flex items-center gap-1 rounded-full bg-white px-3 py-1">
          <FileSearch className="h-3.5 w-3.5" />
          Sources
        </span>
      </div>
      <BillingActions targetPlan={planCode} className="mt-5" />
    </article>
  );
}
