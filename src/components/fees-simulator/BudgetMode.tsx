"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Card, buttonClasses } from "@/components/ui/primitives";
import { maxPriceForBudget } from "@/lib/bid-budget";
import {
  CONSIGNATION_MINIMUM,
  CONSIGNATION_RATE,
  consignationAmount,
} from "@/lib/bid-ceiling-engine";
import { CostLines, AmountField, euro, euroWhole, toAmount } from "./fields";
import { HypothesesFields, type Hypotheses } from "./hypotheses";
import { SimulatorDisclaimer } from "./SimulatorDisclaimer";

export const DEFAULT_SIMULATOR_BUDGET = 150_000;

/**
 * Mode inverse : à partir d'un budget total (prix, frais et travaux compris), le prix
 * d'adjudication maximal. Le calcul est `maxPriceForBudget`, qui rappelle le moteur de frais du
 * simulateur direct : mêmes barèmes, mêmes hypothèses.
 */
export function BudgetMode({
  hypotheses,
  onHypothesisChange,
  budget,
  onBudgetChange,
}: {
  hypotheses: Hypotheses;
  onHypothesisChange: (key: keyof Hypotheses, value: string) => void;
  budget: string;
  onBudgetChange: (value: string) => void;
}) {
  const [startingPrice, setStartingPrice] = useState("");

  const inversion = useMemo(
    () =>
      maxPriceForBudget(toAmount(budget), {
        fpt: toAmount(hypotheses.fpt),
        lawyerFees: toAmount(hypotheses.lawyerFees),
        works: toAmount(hypotheses.works),
        department: hypotheses.department || null,
      }),
    [budget, hypotheses],
  );
  const startingPriceValue = toAmount(startingPrice);
  const consignation =
    startingPriceValue > 0
      ? consignationAmount({ consignation: null, startingPrice: startingPriceValue })
      : null;

  return (
    <div className="grid min-w-0 gap-6 md:grid-cols-2">
      <Card as="section" aria-labelledby="simulateur-budget-hypotheses" className="min-w-0">
        <h2 id="simulateur-budget-hypotheses" className="font-display text-2xl font-semibold">
          Votre budget
        </h2>
        <form
          className="mt-4 grid gap-4"
          onSubmit={(event) => event.preventDefault()}
          aria-label="Budget et hypothèses du simulateur de frais"
        >
          <HypothesesFields
            values={hypotheses}
            onChange={onHypothesisChange}
            lead={
              <AmountField
                label="Budget total"
                hint="Tout compris : prix d’adjudication, frais d’acquisition et travaux. Le simulateur cherche le prix maximal qui tient dans cette somme."
                value={budget}
                onChange={onBudgetChange}
              />
            }
          />
          <AmountField
            label="Mise à prix (facultatif)"
            hint="Pour chiffrer la consignation à remettre à votre avocat avant l’audience."
            value={startingPrice}
            onChange={setStartingPrice}
          />
        </form>
      </Card>

      <Card
        as="section"
        aria-labelledby="simulateur-budget-resultat"
        className="min-w-0 bg-surface-muted"
      >
        <h2 id="simulateur-budget-resultat" className="font-display text-2xl font-semibold">
          Jusqu’où enchérir
        </h2>

        <div className="mt-4 rounded-lg border border-gold/40 bg-white p-4">
          <p className="text-sm font-semibold">Prix d’adjudication maximal</p>
          <p
            aria-live="polite"
            aria-atomic="true"
            className="mt-1 break-words font-display text-3xl font-semibold tabular-nums"
          >
            {inversion.status === "ok"
              ? euroWhole.format(inversion.maxPrice)
              : inversion.status === "too_low"
                ? "Budget insuffisant"
                : "Saisissez un budget"}
          </p>
          {inversion.status === "ok" ? (
            <p className="mt-1 text-sm text-ink-soft">
              Prix arrondi à l’euro inférieur. Avec les frais et les travaux, le coût total est de{" "}
              {euro.format(inversion.costs.totalCost)} pour un budget de{" "}
              {euro.format(inversion.budget)} : il reste {euro.format(inversion.remaining)}.
            </p>
          ) : null}
          {inversion.status === "too_low" ? (
            <p className="mt-1 text-sm text-ink-soft">
              Avant même d’enchérir, les frais préalables, les honoraires, les travaux et les droits
              qui s’y rattachent coûtent déjà {euro.format(inversion.minimumBudget)} : ce budget ne
              laisse rien pour le prix.
            </p>
          ) : null}
          {inversion.status === "invalid" ? (
            <p className="mt-1 text-sm text-ink-soft">
              Saisissez votre budget total pour connaître le prix d’adjudication maximal.
            </p>
          ) : null}
        </div>

        {inversion.status === "ok" ? (
          <>
            <div className="mt-4">
              <h3 className="text-sm font-semibold">Détail des frais à ce prix</h3>
              <CostLines costs={inversion.costs} />
            </div>
            <p className="mt-3 text-sm font-semibold">
              Coût total : {euro.format(inversion.costs.totalCost)}
            </p>
          </>
        ) : null}

        <div className="mt-4 rounded-lg border border-line bg-white p-4 text-sm">
          <p className="font-semibold">Consignation à prévoir avant l’audience</p>
          <p className="mt-1 text-ink-soft">
            Pour pouvoir enchérir, vous remettez à votre avocat {consignationRule()} par chèque de
            banque ou caution bancaire. Elle est restituée si vous n’êtes pas adjudicataire.
            {consignation != null ? (
              <>
                {" "}
                Pour une mise à prix de {euroWhole.format(startingPriceValue)} :{" "}
                <strong className="text-foreground">{euroWhole.format(consignation)}</strong>.
              </>
            ) : (
              <> Saisissez la mise à prix pour la chiffrer.</>
            )}
          </p>
          <p className="mt-2 text-xs leading-relaxed text-ink-soft">
            C’est une avance de trésorerie : le calendrier de l’enchère plafond la retranche du
            solde du prix à payer ensuite, elle ne s’ajoute donc pas au budget total ci-dessus.
          </p>
        </div>

        <p className="mt-4 text-xs leading-relaxed text-ink-soft">
          Hors travaux saisis ci-contre, le financement et le portage (intérêts, taxe foncière,
          charges tant que le bien ne rapporte rien) ne sont pas décomptés de ce budget :
          prévoyez-les en plus si votre budget doit aussi les couvrir.
        </p>
        <SimulatorDisclaimer className="mt-2" />
        <div className="mt-4">
          <Link href="/sales" className={buttonClasses({ variant: "secondary", size: "md" })}>
            Chiffrer une vente précise
          </Link>
        </div>
      </Card>
    </div>
  );
}

function consignationRule(): string {
  return `${Math.round(CONSIGNATION_RATE * 100)} % de la mise à prix, ${euroWhole.format(CONSIGNATION_MINIMUM)} au minimum,`;
}
