import Wrench from "lucide-react/dist/esm/icons/wrench.js";
import { estimateWorksBudget, WORKS_SCENARIOS, type WorksScenarioKey } from "@/lib/profitability";
import { formatPrice, formatPricePerM2, formatSurface } from "@/lib/format";

const fmt = (value: number) => formatPrice(Math.round(value || 0));
const ppm2 = (value: number | null | undefined) => formatPricePerM2(value);

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
