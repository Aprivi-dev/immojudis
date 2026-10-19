"use client";

import { useMemo, useState, type ReactNode } from "react";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.js";
import Info from "lucide-react/dist/esm/icons/info.js";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw.js";
import Target from "lucide-react/dist/esm/icons/target.js";
import {
  buildCashPlan,
  CEILING_PROFILES,
  CEILING_PROJECTS,
  ceilingConfidence,
  ceilingsByWorks,
  computeCeilingPlan,
  evaluateBid,
  targetYieldPct,
  type CeilingHypotheses,
  type CeilingPlan,
  type CeilingStep,
} from "@/lib/bid-ceiling-engine";
import type { CeilingUserChoices } from "@/lib/bid-ceiling-defaults";
import { ceilingGap, UNPROFITABLE_HEADLINE } from "@/lib/bid-ceiling-gaps";
import { formatPrice } from "@/lib/format";
import { dpeRentalNote } from "@/lib/works-guidance";
import { CeilingHypothesesPanel } from "@/components/ceiling/CeilingHypothesesPanel";
import { Terme, type TermeKey } from "@/components/ceiling/Terme";

type ChoicesUpdate = (change: (choices: CeilingUserChoices) => CeilingUserChoices) => void;

export function CeilingPlanner({
  hypotheses,
  plan,
  choices,
  onChoicesChange,
  onReset,
  onEditWorks,
  marketLoading = false,
  valueReason,
  dpeClass = null,
}: {
  hypotheses: CeilingHypotheses;
  plan: CeilingPlan;
  choices: CeilingUserChoices;
  onChoicesChange: ChoicesUpdate;
  onReset: () => void;
  onEditWorks?: () => void;
  marketLoading?: boolean;
  /** Pourquoi la valeur de marché manque (« estimation en cours », …), quand elle manque. */
  valueReason?: string;
  dpeClass?: string | null;
}) {
  const [hypothesesOpen, setHypothesesOpen] = useState(false);
  const confidence = ceilingConfidence(hypotheses);
  const gap = ceilingGap(plan, valueReason);
  const profilePlans = useMemo(
    () =>
      CEILING_PROFILES.map((profile) => ({
        ...profile,
        plan: computeCeilingPlan({ ...hypotheses, profile: profile.key, customMarginPct: null }),
      })),
    [hypotheses],
  );

  return (
    <section
      aria-labelledby="ceiling-planner-title"
      className="overflow-hidden rounded-lg border border-border bg-white shadow-sm"
    >
      <div className="p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2
              id="ceiling-planner-title"
              className="font-display text-2xl font-medium text-brand-navy sm:text-3xl"
            >
              Votre enchère plafond
            </h2>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
              Le montant à ne pas dépasser à l’audience, une fois comptés la valeur du bien, votre
              marge, les travaux, la libération, le portage et tous les frais de la vente.
            </p>
          </div>
          <button
            type="button"
            onClick={onReset}
            className="inline-flex min-h-11 items-center gap-2 rounded-full border border-border px-3 text-xs font-semibold text-muted-foreground hover:text-foreground"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Revenir aux hypothèses Immojudis
          </button>
        </div>

        <ProjectPicker project={hypotheses.project} onChoicesChange={onChoicesChange} />

        <div className="mt-5 rounded-lg border border-gold/30 bg-gold/[0.07] p-5 sm:p-6">
          <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-5">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-gold-text">
                <Target className="h-4 w-4" />
                Enchère plafond (simulation) · {profileLabel(hypotheses)}
              </div>
              {gap == null || marketLoading ? (
                <div className="mt-3 text-4xl font-semibold leading-none tabular-nums text-foreground sm:text-5xl">
                  {gap == null ? formatPrice(plan.maxBid) : "Calcul…"}
                </div>
              ) : (
                <div className="mt-3 max-w-md text-2xl font-semibold leading-tight text-foreground sm:text-3xl">
                  {gap.kind === "unprofitable"
                    ? UNPROFITABLE_HEADLINE
                    : `À compléter : ${gap.reason}`}
                </div>
              )}
              <Verdict hypotheses={hypotheses} plan={plan} />
            </div>
            <ProfilePicker
              profiles={profilePlans}
              selected={choices.customMarginPct != null ? null : hypotheses.profile}
              onChoicesChange={onChoicesChange}
            />
          </div>
          <ConfidenceNote confidence={confidence} />
        </div>

        {plan.available ? (
          <>
            <CeilingSteps steps={plan.steps} />
            <WorksCeilings hypotheses={hypotheses} onEditWorks={onEditWorks} />
            <BidSimulator hypotheses={hypotheses} plan={plan} />
            <CashPlan hypotheses={hypotheses} plan={plan} />
          </>
        ) : null}

        <button
          type="button"
          aria-expanded={hypothesesOpen || !plan.available}
          onClick={() => setHypothesesOpen((open) => !open)}
          className="mt-6 inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-gold-text"
        >
          <ChevronDown
            className={`h-4 w-4 transition-transform ${hypothesesOpen || !plan.available ? "rotate-180" : ""}`}
          />
          {hypothesesOpen || !plan.available ? "Masquer les hypothèses" : "Modifier les hypothèses"}
        </button>
        {hypothesesOpen || !plan.available ? (
          <CeilingHypothesesPanel
            hypotheses={hypotheses}
            choices={choices}
            onChoicesChange={onChoicesChange}
          />
        ) : null}

        <Checklist hypotheses={hypotheses} dpeClass={dpeClass} />

        <p className="mt-5 flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gold-text" />
          <span>
            Aide à la décision calculée avec vos hypothèses : elle ne remplace ni la lecture du{" "}
            <Terme terme="cahier-conditions-vente" placement="top">
              cahier des conditions de vente
            </Terme>{" "}
            ni le conseil de votre avocat. Aucun prix d’adjudication n’est garanti.
          </span>
        </p>
      </div>
    </section>
  );
}

function profileLabel(h: CeilingHypotheses): string {
  if (h.customMarginPct != null) return `marge personnalisée ${h.customMarginPct} %`;
  return CEILING_PROFILES.find((profile) => profile.key === h.profile)?.label ?? "";
}

function ProjectPicker({
  project,
  onChoicesChange,
}: {
  project: CeilingHypotheses["project"];
  onChoicesChange: ChoicesUpdate;
}) {
  return (
    <div className="mt-5">
      <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        Votre projet
      </div>
      <div role="radiogroup" aria-label="Votre projet" className="mt-2 grid gap-2 sm:grid-cols-3">
        {CEILING_PROJECTS.map((item) => {
          const selected = item.key === project;
          return (
            <button
              key={item.key}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChoicesChange((choices) => ({ ...choices, project: item.key }))}
              className={`rounded-lg border p-3 text-left transition ${
                selected
                  ? "border-gold bg-gold/10 text-foreground"
                  : "border-border text-muted-foreground hover:border-gold/50"
              }`}
            >
              <span className="block text-sm font-semibold text-foreground">{item.label}</span>
              <span className="mt-1 block text-xs leading-relaxed">{item.summary}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ProfilePicker({
  profiles,
  selected,
  onChoicesChange,
}: {
  profiles: Array<{ key: CeilingHypotheses["profile"]; label: string; plan: CeilingPlan }>;
  selected: CeilingHypotheses["profile"] | null;
  onChoicesChange: ChoicesUpdate;
}) {
  return (
    <div role="radiogroup" aria-label="Niveau de prudence" className="grid grid-cols-3 gap-1.5">
      {profiles.map((profile) => {
        const active = profile.key === selected;
        return (
          <button
            key={profile.key}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() =>
              onChoicesChange((choices) => ({
                ...choices,
                profile: profile.key,
                customMarginPct: null,
              }))
            }
            className={`min-h-14 rounded-lg border px-3 py-2 text-left transition ${
              active
                ? "border-gold bg-gold text-brand-navy"
                : "border-border bg-white text-muted-foreground hover:text-foreground"
            }`}
          >
            <span className="block text-xs font-semibold">{profile.label}</span>
            <span className="block text-sm font-semibold tabular-nums">
              {profile.plan.available && profile.plan.reachable
                ? formatPrice(profile.plan.maxBid)
                : "—"}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function Verdict({ hypotheses, plan }: { hypotheses: CeilingHypotheses; plan: CeilingPlan }) {
  const start = positiveAmount(hypotheses.startingPrice);
  const startingPrice = <Terme terme="mise-a-prix">mise à prix</Terme>;
  const limitedByRent = plan.available && plan.reachable && plan.binding === "rendement";
  return (
    <>
      <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">
        {!plan.available ? (
          `${plan.reason}. Complétez-la dans les hypothèses ci-dessous pour obtenir votre plafond.`
        ) : !plan.reachable ? (
          "À ces hypothèses, aucun prix d’enchère ne respecte la marge choisie : travaux, libération et frais dépassent déjà le coût total maximal."
        ) : start && plan.maxBid < start ? (
          <>
            À ces hypothèses, votre plafond ({formatPrice(plan.maxBid)}) est inférieur à la{" "}
            {startingPrice} ({formatPrice(start)}) : une enchère à la mise à prix ne respecterait
            pas la marge de sécurité choisie.
          </>
        ) : start ? (
          <>
            La {startingPrice} ({formatPrice(start)}) est inférieure à votre plafond de{" "}
            {formatPrice(plan.maxBid)} (simulation, hors aléas).
          </>
        ) : (
          <>
            <Terme terme="mise-a-prix">Mise à prix</Terme> non communiquée : comparez votre plafond
            au montant annoncé à l’audience.
          </>
        )}
        {limitedByRent
          ? ` Ici, c’est le loyer qui limite le plafond (rendement net visé ${targetYieldPct(hypotheses)} %).`
          : ""}
      </p>
      {plan.rentMissing ? (
        <p role="status" className="mt-2 max-w-xl text-sm font-semibold leading-relaxed">
          Loyer non renseigné : le plafond ne tient pas compte du rendement. Saisissez un loyer.
        </p>
      ) : null}
    </>
  );
}

function positiveAmount(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value > 0 ? value : null;
}

function ConfidenceNote({ confidence }: { confidence: ReturnType<typeof ceilingConfidence> }) {
  return (
    <p className="mt-5 border-t border-gold/20 pt-4 text-sm leading-relaxed text-muted-foreground">
      <strong className="text-foreground">Fiabilité : {confidence.label}.</strong>{" "}
      {confidence.gaps.length
        ? `Reste à confirmer : ${confidence.gaps.join(", ")}.`
        : "Valeur, surface, occupation et frais préalables sont renseignés."}
    </p>
  );
}

function CeilingSteps({ steps }: { steps: CeilingStep[] }) {
  return (
    <section
      id="why-this-ceiling"
      aria-labelledby="ceiling-steps-title"
      className="mt-7 scroll-mt-36"
    >
      <h3 id="ceiling-steps-title" className="text-lg font-semibold text-brand-navy">
        Le calcul, étape par étape
      </h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Touchez ou cliquez sur une ligne pour voir d’où vient le chiffre.
      </p>
      <ol className="mt-4 divide-y divide-border border-y border-border">
        {steps.map((step) => (
          <li key={step.key}>
            <details className="group">
              <summary
                className={`flex min-h-11 cursor-pointer list-none items-baseline justify-between gap-4 py-3 [&::-webkit-details-marker]:hidden ${
                  step.kind === "subtotal" || step.kind === "result" ? "font-semibold" : ""
                }`}
              >
                <span className="flex min-w-0 items-baseline gap-2">
                  <ChevronDown
                    aria-hidden
                    className="h-4 w-4 shrink-0 translate-y-0.5 text-muted-foreground transition-transform group-open:rotate-180"
                  />
                  <span
                    className={`text-sm sm:text-base ${
                      step.kind === "result" ? "text-brand-navy" : "text-foreground"
                    }`}
                  >
                    {step.label}
                  </span>
                </span>
                <span
                  className={`shrink-0 tabular-nums ${
                    step.kind === "result"
                      ? "text-xl text-brand-navy"
                      : step.kind === "minus"
                        ? "text-gold-text"
                        : "text-foreground"
                  }`}
                >
                  {step.kind === "minus" ? "− " : step.kind === "add" ? "+ " : ""}
                  {formatPrice(Math.abs(step.amount))}
                </span>
              </summary>
              <p className="pb-3 pl-6 text-sm leading-relaxed text-muted-foreground">
                {step.detail}
              </p>
            </details>
          </li>
        ))}
      </ol>
    </section>
  );
}

function WorksCeilings({
  hypotheses,
  onEditWorks,
}: {
  hypotheses: CeilingHypotheses;
  onEditWorks?: () => void;
}) {
  const rows = useMemo(() => ceilingsByWorks(hypotheses), [hypotheses]);
  return (
    <section aria-labelledby="ceiling-works-title" className="mt-8">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="ceiling-works-title" className="text-lg font-semibold text-brand-navy">
          Votre plafond selon les travaux
        </h3>
        {onEditWorks ? (
          <button
            type="button"
            onClick={onEditWorks}
            className="text-sm font-semibold text-gold-text underline-offset-4 hover:underline"
          >
            Choisir les travaux
          </button>
        ) : null}
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Les scénarios incluent 10 % d’imprévus et le portage pendant le chantier ; une rénovation
        complète peut aussi augmenter la valeur du bien.
      </p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-[0.08em] text-muted-foreground">
              <th className="py-2 font-semibold">Travaux</th>
              <th className="py-2 pl-2 text-right font-semibold">Budget</th>
              <th className="py-2 pl-2 text-right font-semibold">Plafond</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border border-y border-border">
            {rows.map((row) => {
              const selected = row.key === hypotheses.works.key;
              return (
                <tr key={row.key} aria-current={selected ? "true" : undefined}>
                  <td className="py-2.5">
                    <span className={selected ? "font-semibold text-foreground" : ""}>
                      {row.label}
                    </span>
                    {selected ? (
                      <span className="ml-2 rounded-full bg-gold/15 px-2 py-0.5 text-[11px] font-semibold text-gold-text">
                        Retenu
                      </span>
                    ) : null}
                  </td>
                  <td className="whitespace-nowrap py-2.5 pl-2 text-right tabular-nums">
                    {row.works > 0 ? formatPrice(row.works) : "—"}
                  </td>
                  <td className="whitespace-nowrap py-2.5 pl-2 text-right font-semibold tabular-nums">
                    {row.plan.reachable ? formatPrice(row.plan.maxBid) : "Aucun"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function BidSimulator({ hypotheses, plan }: { hypotheses: CeilingHypotheses; plan: CeilingPlan }) {
  const defaultBid = hypotheses.startingPrice ?? plan.maxBid;
  const [bid, setBid] = useState<number>(defaultBid);
  const evaluation = evaluateBid(hypotheses, plan, bid);
  const fees = evaluation.fees;
  const rows: Array<[label: string, value: number, term?: TermeKey]> = [
    ["Prix d’adjudication", evaluation.price, "adjudication"],
    ["Frais préalables", fees.fpt, "frais-prealables"],
    ["Droits d’enregistrement", fees.registrationDuties + fees.csi + fees.vatOnPrice],
    ["Émoluments de l’avocat poursuivant", fees.emolumentsTTC, "emoluments"],
    ["Honoraires de votre avocat", fees.lawyerFees],
    ["Travaux et imprévus", plan.worksTotal],
    ["Libération du bien", plan.releaseCost, "liberation"],
    ["Portage", plan.carryingFixed + evaluation.financing, "portage"],
  ];
  return (
    <section aria-labelledby="ceiling-simulator-title" className="mt-8">
      <h3 id="ceiling-simulator-title" className="text-lg font-semibold text-brand-navy">
        Si vous l’emportez à…
      </h3>
      <label className="mt-3 flex max-w-xs items-center gap-2 rounded-lg border border-border px-3 focus-within:border-gold">
        <span className="sr-only">Montant de l’enchère simulée</span>
        <input
          type="number"
          inputMode="numeric"
          min={0}
          step={500}
          value={Number.isFinite(bid) ? bid : 0}
          onChange={(event) => setBid(Math.max(0, Number(event.target.value) || 0))}
          className="min-h-11 w-full bg-transparent text-lg font-semibold tabular-nums outline-none"
        />
        <span className="text-sm text-muted-foreground">€</span>
      </label>
      <div className="mt-2 flex flex-wrap gap-2 text-xs">
        {hypotheses.startingPrice ? (
          <QuickBid label="Mise à prix" value={hypotheses.startingPrice} onPick={setBid} />
        ) : null}
        {plan.reachable ? <QuickBid label="Plafond" value={plan.maxBid} onPick={setBid} /> : null}
      </div>
      <dl className="mt-4 divide-y divide-border border-y border-border text-sm">
        {rows
          .filter(([, value]) => value > 0)
          .map(([label, value, term]) => (
            <div key={label} className="flex justify-between gap-4 py-2">
              <dt className="text-muted-foreground">
                {term ? <Terme terme={term}>{label}</Terme> : label}
              </dt>
              <dd className="tabular-nums">{formatPrice(Math.round(value))}</dd>
            </div>
          ))}
        <div className="flex justify-between gap-4 py-2.5 font-semibold">
          <dt>Coût total de l’opération</dt>
          <dd className="tabular-nums">{formatPrice(evaluation.totalCost)}</dd>
        </div>
      </dl>
      <p
        role="status"
        className={`mt-3 rounded-lg px-3 py-2 text-sm ${
          evaluation.headroom >= 0
            ? "bg-muted text-foreground"
            : "bg-[var(--danger-tint)] text-[var(--danger)]"
        }`}
      >
        {evaluation.headroom >= 0
          ? `Vous restez ${formatPrice(evaluation.headroom)} sous votre coût total maximal.`
          : `Vous dépassez votre coût total maximal de ${formatPrice(-evaluation.headroom)}.`}
        {evaluation.netYieldPct != null
          ? ` Rendement net estimé : ${evaluation.netYieldPct.toLocaleString("fr-FR")} %.`
          : ""}
        {evaluation.resaleProfit != null
          ? ` Bénéfice avant impôt à la revente : ${formatPrice(evaluation.resaleProfit)}.`
          : ""}
      </p>
    </section>
  );
}

function QuickBid({
  label,
  value,
  onPick,
}: {
  label: string;
  value: number;
  onPick: (value: number) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onPick(value)}
      className="min-h-11 rounded-full border border-border px-3 font-semibold text-muted-foreground hover:text-foreground"
    >
      {label} · {formatPrice(value)}
    </button>
  );
}

/** Libellés de `buildCashPlan` qui portent un terme à définir. */
const CASH_STEP_TERMS: Record<string, TermeKey> = {
  Consignation: "garantie-encherir",
  "Fin du délai de surenchère": "surenchere",
  "Libération du bien": "liberation",
};

function CashPlan({ hypotheses, plan }: { hypotheses: CeilingHypotheses; plan: CeilingPlan }) {
  const price = plan.reachable ? plan.maxBid : (hypotheses.startingPrice ?? 0);
  const steps = buildCashPlan(hypotheses, plan, price);
  return (
    <section aria-labelledby="ceiling-cash-title" className="mt-8">
      <h3 id="ceiling-cash-title" className="text-lg font-semibold text-brand-navy">
        Trésorerie à prévoir
      </h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Pour une adjudication à {formatPrice(price)}, dans l’ordre où les sommes sont dues.
      </p>
      <ol className="mt-4 space-y-3">
        {steps.map((step) => (
          <li
            key={`${step.when}-${step.label}`}
            className="grid gap-1 sm:grid-cols-[8.5rem_1fr_auto] sm:gap-4"
          >
            <span className="text-xs font-semibold uppercase tracking-[0.08em] text-gold-text">
              {step.when}
            </span>
            <span className="text-sm">
              <span className="font-semibold text-foreground">
                {CASH_STEP_TERMS[step.label] ? (
                  <Terme terme={CASH_STEP_TERMS[step.label]}>{step.label}</Terme>
                ) : (
                  step.label
                )}
              </span>
              <span className="block text-muted-foreground">{step.detail}</span>
            </span>
            <span className="text-sm font-semibold tabular-nums sm:text-right">
              {step.amount != null ? formatPrice(step.amount) : ""}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Checklist({
  hypotheses,
  dpeClass,
}: {
  hypotheses: CeilingHypotheses;
  dpeClass: string | null;
}) {
  const items: Array<{ key: string; content: ReactNode }> = [];
  const procesVerbal = (
    <Terme terme="proces-verbal-descriptif" placement="top">
      procès-verbal descriptif
    </Terme>
  );
  if (hypotheses.feesSource.fpt === "defaut")
    items.push({
      key: "frais-prealables",
      content: (
        <>
          Demandez à l’avocat poursuivant le montant des{" "}
          <Terme terme="frais-prealables" placement="top">
            frais préalables
          </Terme>{" "}
          : ils s’ajoutent au prix.
        </>
      ),
    });
  if (hypotheses.occupation.case === "inconnu")
    items.push({
      key: "occupation-inconnue",
      content: <>Vérifiez l’occupation dans le {procesVerbal}.</>,
    });
  if (hypotheses.occupation.case === "loue")
    items.push({
      key: "bail",
      content: "Demandez le bail, le montant du loyer et la date de fin du bail.",
    });
  if (hypotheses.value.surfaceEstimated)
    items.push({
      key: "surface",
      content: (
        <>
          Confirmez la surface (loi Carrez ou habitable) dans le {procesVerbal} et les diagnostics
          annexés au cahier des conditions de vente.
        </>
      ),
    });
  const dpe = dpeRentalNote(dpeClass);
  if (dpe && hypotheses.project === "louer") items.push({ key: "dpe", content: dpe.text });
  items.push(
    {
      key: "assemblees-generales",
      content:
        "Lisez les procès-verbaux d’assemblée générale : des travaux votés peuvent être appelés après la vente.",
    },
    {
      key: "preemption",
      content: (
        <>
          Selon la situation du bien, la commune (ou un autre titulaire prévu par la loi) peut
          exercer un{" "}
          <Terme terme="droit-preemption" placement="top">
            droit de préemption
          </Terme>{" "}
          et se substituer à l’adjudicataire dans les 30 jours de l’adjudication. Demandez à votre
          avocat si le bien est concerné.
        </>
      ),
    },
    {
      key: "plafond-avant-audience",
      content:
        "Fixez votre plafond avant l’audience et donnez-le à votre avocat : les enchères vont vite.",
    },
  );
  return (
    <section aria-labelledby="ceiling-checklist-title" className="mt-8">
      <h3 id="ceiling-checklist-title" className="text-lg font-semibold text-brand-navy">
        À vérifier avant l’audience
      </h3>
      <ul className="mt-3 list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-muted-foreground">
        {items.map((item) => (
          <li key={item.key}>{item.content}</li>
        ))}
      </ul>
    </section>
  );
}
