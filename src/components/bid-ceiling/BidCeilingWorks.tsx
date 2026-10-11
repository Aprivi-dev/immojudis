import ArrowRight from "lucide-react/dist/esm/icons/arrow-right.js";
import Wrench from "lucide-react/dist/esm/icons/wrench.js";
import { estimateWorksBudget, WORKS_SCENARIOS, type WorksScenarioKey } from "@/lib/profitability";
import { formatSurface } from "@/lib/format";
import { fmt, ppm2 } from "@/components/bid-ceiling/assistant-state";

/**
 * Works envelope: the maximum renovation budget that still keeps the all-in cost
 * (purchase + fees + works) under the scenario's market threshold, at the
 * simulated bid. Defaults to the starting price; shrinks as the bid rises.
 */
export function WorksEnvelope({
  maxWorks,
  simulatedPrice,
  startingPrice,
}: {
  maxWorks: number;
  simulatedPrice: number;
  startingPrice: number;
}) {
  const atStartingPrice = Math.round(simulatedPrice) === Math.round(startingPrice);
  const noRoom = maxWorks <= 0;
  return (
    <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-3 rounded-lg border border-border bg-muted/35 p-4">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-gold/30 bg-gold/10 text-gold-text">
        <Wrench className="h-5 w-5" />
      </span>
      <div className="min-w-0">
        <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-gold-text">
          Enveloppe travaux maximale
        </div>
        <div className="mt-1 text-3xl font-semibold leading-none tabular-nums text-foreground">
          {fmt(Math.max(0, Math.floor(maxWorks / 100) * 100))}
        </div>
      </div>
      <p className="min-w-[12rem] flex-1 text-sm leading-relaxed text-muted-foreground">
        {noRoom ? (
          <>
            À cette mise{atStartingPrice ? " (la mise à prix)" : ""}, le coût d'acquisition atteint
            déjà le seuil de marché : plus aucune marge pour des travaux sans sortir du plafond.
          </>
        ) : (
          <>
            Montant maximum à engager en travaux si vous l'emportez
            {atStartingPrice ? " à la mise à prix" : ` à ${fmt(simulatedPrice)}`}, sans que le coût
            complet (achat + frais + travaux) dépasse le seuil de marché du scénario. Plus votre
            mise monte, plus cette enveloppe se réduit.
          </>
        )}
      </p>
    </div>
  );
}

/** Scenario whose surface × price matches the amount exactly, if any. */
export function worksScenarioForAmount(
  surface: number | null | undefined,
  works: number,
): WorksScenarioKey | null {
  if (!surface || surface <= 0 || works <= 0) return null;
  return (
    WORKS_SCENARIOS.find((scenario) => estimateWorksBudget(surface, scenario.key) === works)?.key ??
    null
  );
}

/**
 * Reminder of the works budget used by the ceiling. The budget itself is chosen
 * in the Travaux tab, so the two tabs never hold diverging amounts.
 */
export function WorksSummary({
  surface,
  works,
  onEditWorks,
}: {
  surface: number;
  works: number;
  onEditWorks?: () => void;
}) {
  const scenario = WORKS_SCENARIOS.find(
    (item) => item.key === worksScenarioForAmount(surface, works),
  );
  return (
    <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-3 rounded-lg border border-border bg-muted/35 p-4">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-gold/30 bg-gold/10 text-gold-text">
        <Wrench className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-gold-text">
          Travaux retenus dans ce plafond
        </div>
        <div className="mt-1 text-lg font-semibold tabular-nums text-foreground">
          {works > 0 ? fmt(works) : "Aucun"}
          <span className="ml-2 text-sm font-normal text-muted-foreground">
            {works <= 0
              ? "le bien est repris en l’état"
              : scenario
                ? `${scenario.label} · ${ppm2(scenario.pricePerM2)}`
                : "montant personnalisé"}
          </span>
        </div>
      </div>
      {onEditWorks ? (
        <button
          type="button"
          onClick={onEditWorks}
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-gold-text underline-offset-4 hover:underline"
        >
          {works > 0 ? "Modifier les travaux" : "Chiffrer les travaux"}
          <ArrowRight className="h-4 w-4" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

export function WorksScenarioSelector({
  surface,
  works,
  selectedScenario,
  suggestedScenario,
  suggestionReason,
  onSelect,
}: {
  surface: number;
  works: number;
  selectedScenario: WorksScenarioKey | null;
  /** `undefined`: no suggestion; `null`: the property can be taken as is. */
  suggestedScenario?: WorksScenarioKey | null;
  suggestionReason?: string;
  onSelect: (scenario: WorksScenarioKey | null) => void;
}) {
  const noWorksSelected = selectedScenario == null && works === 0;
  const cardClass = (selected: boolean) =>
    `flex h-full flex-col rounded-lg border p-4 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
      selected
        ? "border-gold bg-gold/[0.09] shadow-[0_0_0_1px_rgb(192_138_68/20%)]"
        : "border-border bg-white hover:border-gold/45 hover:bg-gold/[0.04]"
    }`;
  const badge = (selected: boolean, suggested: boolean) =>
    selected ? (
      <span className="rounded-full bg-gold px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-brand-navy">
        Retenu
      </span>
    ) : suggested ? (
      <span className="rounded-full border border-gold/40 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-gold-text">
        Suggéré
      </span>
    ) : null;

  return (
    <div className="rounded-lg border border-border bg-muted/35 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-gold-text">
            <Wrench className="h-4 w-4" />
            Scénario de travaux
          </div>
          <h3 className="mt-2 text-base font-semibold text-foreground">
            Quels travaux prévoyez-vous ?
          </h3>
          <p className="mt-1 max-w-3xl text-sm leading-relaxed text-muted-foreground">
            Budget estimé sur les {formatSurface(surface)} du bien (surface × prix moyen au m²).
            Aucun montant n’est retenu tant que vous n’avez pas choisi.
            {suggestionReason ? ` ${suggestionReason}` : ""}
          </p>
        </div>
      </div>

      <div
        className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
        role="radiogroup"
        aria-label="Étendue estimée des travaux"
      >
        <button
          type="button"
          role="radio"
          aria-checked={noWorksSelected}
          onClick={() => onSelect(null)}
          className={cardClass(noWorksSelected)}
        >
          <span className="flex items-start justify-between gap-3">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Sans travaux
            </span>
            {badge(noWorksSelected, suggestedScenario === null)}
          </span>
          <span className="mt-3 text-base font-semibold text-foreground">Aucun travaux</span>
          <span className="mt-3 text-sm leading-relaxed text-muted-foreground">
            Le bien est repris en l’état, sans budget de rénovation.
          </span>
          <span className="mt-auto block pt-4 text-xs text-muted-foreground">
            <span className="block border-t border-border pt-3">
              Pour ce bien : <strong className="text-sm tabular-nums text-foreground">0 €</strong>
            </span>
          </span>
        </button>
        {WORKS_SCENARIOS.map((scenario) => {
          const selected = scenario.key === selectedScenario;
          const budget = estimateWorksBudget(surface, scenario.key);
          return (
            <button
              key={scenario.key}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onSelect(scenario.key)}
              className={cardClass(selected)}
            >
              <span className="flex items-start justify-between gap-3">
                <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  {ppm2(scenario.pricePerM2)}
                </span>
                {badge(selected, suggestedScenario === scenario.key)}
              </span>
              <span className="mt-3 text-base font-semibold text-foreground">{scenario.label}</span>
              <span className="mt-3 text-sm leading-relaxed text-muted-foreground">
                {scenario.summary}
              </span>
              <span className="mt-2 text-xs leading-relaxed text-muted-foreground">
                {scenario.scope}
              </span>
              <span className="mt-auto block pt-4 text-xs text-muted-foreground">
                <span className="block border-t border-border pt-3">
                  Pour ce bien :{" "}
                  <strong className="text-sm tabular-nums text-foreground">{fmt(budget)}</strong>
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
