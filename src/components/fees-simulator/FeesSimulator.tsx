"use client";

import { useMemo, useRef, useState } from "react";
import { Card } from "@/components/ui/primitives";
import { trackProductEvent } from "@/lib/product-events";
import { computeAcquisitionCosts } from "@/lib/profitability";
import type { SurenchereReminder } from "@/lib/surenchere-reminder";
import { BudgetMode, DEFAULT_SIMULATOR_BUDGET } from "./BudgetMode";
import { formatPercent, formatPrice } from "@/lib/format/numbers";
import { AmountField, CostLines, toAmount } from "./fields";
import { DEFAULT_HYPOTHESES, HypothesesFields, type Hypotheses } from "./hypotheses";
import { ModeSelector, type SimulatorMode } from "./ModeSelector";
import { DEFAULT_SURENCHERE_PRICE, SurenchereMode } from "./SurenchereMode";

export const DEFAULT_SIMULATOR_PRICE = 100_000;

export function FeesSimulator({
  surenchereReminder = null,
}: {
  /** Rappel du délai de surenchère, lu dans l'article par la page (serveur). */
  surenchereReminder?: SurenchereReminder | null;
}) {
  const [mode, setMode] = useState<SimulatorMode>("cost");
  const [price, setPrice] = useState(String(DEFAULT_SIMULATOR_PRICE));
  const [budget, setBudget] = useState(String(DEFAULT_SIMULATOR_BUDGET));
  const [surenchereBase, setSurenchereBase] = useState(String(DEFAULT_SURENCHERE_PRICE));
  // Les hypothèses de frais sont communes au calcul direct et au calcul inverse.
  const [hypotheses, setHypotheses] = useState<Hypotheses>(DEFAULT_HYPOTHESES);

  // Mesure anonyme : une seule fois par visite de la page, au premier changement d'un champ.
  const usageTracked = useRef(false);
  const edited =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      if (!usageTracked.current) {
        usageTracked.current = true;
        trackProductEvent("fees_simulator_used");
      }
      set(value);
    };
  const changeHypothesis = edited(({ key, value }: { key: keyof Hypotheses; value: string }) =>
    setHypotheses((current) => ({ ...current, [key]: value })),
  );
  const onHypothesisChange = (key: keyof Hypotheses, value: string) =>
    changeHypothesis({ key, value });

  return (
    <div className="grid min-w-0 gap-6">
      <ModeSelector mode={mode} onChange={setMode} />
      {mode === "cost" ? (
        <CostMode
          price={price}
          onPriceChange={edited(setPrice)}
          hypotheses={hypotheses}
          onHypothesisChange={onHypothesisChange}
        />
      ) : null}
      {mode === "budget" ? (
        <BudgetMode
          budget={budget}
          onBudgetChange={edited(setBudget)}
          hypotheses={hypotheses}
          onHypothesisChange={onHypothesisChange}
        />
      ) : null}
      {mode === "surenchere" ? (
        <SurenchereMode
          price={surenchereBase}
          onPriceChange={edited(setSurenchereBase)}
          reminder={surenchereReminder}
        />
      ) : null}
    </div>
  );
}

/** Calcul direct : du prix d'adjudication au coût total. */
function CostMode({
  price,
  onPriceChange,
  hypotheses,
  onHypothesisChange,
}: {
  price: string;
  onPriceChange: (value: string) => void;
  hypotheses: Hypotheses;
  onHypothesisChange: (key: keyof Hypotheses, value: string) => void;
}) {
  const costs = useMemo(
    () =>
      computeAcquisitionCosts({
        price: toAmount(price),
        fpt: toAmount(hypotheses.fpt),
        lawyerFees: toAmount(hypotheses.lawyerFees),
        works: toAmount(hypotheses.works),
        department: hypotheses.department || null,
      }),
    [price, hypotheses],
  );
  const feesPct = formatPercent(costs.acquisitionFeesPct, 1);

  return (
    <div className="grid min-w-0 gap-6 md:grid-cols-2">
      <Card as="section" aria-labelledby="simulateur-hypotheses" className="min-w-0">
        <h2 id="simulateur-hypotheses" className="font-display text-2xl font-semibold">
          Vos hypothèses
        </h2>
        <form
          className="mt-4 grid gap-4"
          onSubmit={(event) => event.preventDefault()}
          aria-label="Hypothèses du simulateur de frais"
        >
          <HypothesesFields
            values={hypotheses}
            onChange={onHypothesisChange}
            lead={
              <AmountField
                label="Prix d’adjudication"
                hint="Le prix auquel le bien est adjugé, hors frais."
                value={price}
                onChange={onPriceChange}
              />
            }
          />
        </form>
      </Card>

      <Card as="section" aria-labelledby="simulateur-resultat" className="min-w-0 bg-surface-muted">
        <h2 id="simulateur-resultat" className="font-display text-2xl font-semibold">
          Détail du coût
        </h2>
        <div className="mt-4 rounded-lg border border-gold/40 bg-white p-4">
          <p className="text-sm font-semibold">Coût total</p>
          <p
            aria-live="polite"
            aria-atomic="true"
            className="mt-1 break-words font-display text-3xl font-semibold tabular-nums"
          >
            {formatPrice(costs.totalCost)}
          </p>
          {costs.price > 0 ? (
            <p className="mt-1 text-sm text-ink-soft">
              dont {formatPrice(costs.acquisitionFeesTotal)} de frais d’acquisition, soit {feesPct}{" "}
              du prix d’adjudication.
            </p>
          ) : (
            <p className="mt-1 text-sm text-ink-soft">
              Saisissez un prix d’adjudication pour chiffrer les frais.
            </p>
          )}
          <p className="mt-2 text-xs leading-relaxed text-ink-soft">
            Hors travaux saisis ci-dessus, le financement et le portage (intérêts, taxe foncière,
            charges tant que le bien ne rapporte rien) ne sont pas inclus.
          </p>
        </div>
        <p className="mt-4 text-xs text-ink-soft">
          Le total est arrondi à l’euro ; le détail ci-dessous est au centime.
        </p>
        <div className="mt-1">
          <CostLines costs={costs} />
        </div>
      </Card>

      {/* Sous le point de rupture « lg », le total reste visible pendant la saisie des hypothèses
          (au-dessus du bandeau des cookies quand il est ouvert). */}
      <div
        data-testid="simulateur-total-collant"
        aria-hidden="true"
        className="sticky bottom-[var(--cookie-banner-height,0px)] z-20 -mx-4 border-t border-line bg-white/95 px-4 py-3 text-sm shadow-[0_-10px_28px_rgba(19,34,56,0.1)] backdrop-blur sm:mx-0 sm:rounded-lg sm:border md:col-span-2 lg:hidden"
      >
        <span className="font-semibold">Coût total</span>{" "}
        <span className="font-semibold tabular-nums">{formatPrice(costs.totalCost)}</span>
        {costs.price > 0 ? <span className="text-ink-soft"> · dont {feesPct} de frais</span> : null}
      </div>
    </div>
  );
}
