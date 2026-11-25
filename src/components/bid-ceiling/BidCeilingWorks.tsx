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
  const selected = WORKS_SCENARIOS.find((scenario) => scenario.key === selectedScenario);
  const options: {
    key: WorksScenarioKey | null;
    label: string;
    rate: string | null;
    budget: number;
    checked: boolean;
  }[] = [
    { key: null, label: "Aucun travaux", rate: null, budget: 0, checked: noWorksSelected },
    ...WORKS_SCENARIOS.map((scenario) => ({
      key: scenario.key,
      label: scenario.label,
      rate: ppm2(scenario.pricePerM2),
      budget: estimateWorksBudget(surface, scenario.key),
      checked: scenario.key === selectedScenario,
    })),
  ];

  return (
    <div className="@container">
      <h3 className="text-base font-semibold text-foreground">Quels travaux prévoyez-vous ?</h3>
      <p className="mt-1 max-w-3xl text-sm leading-relaxed text-muted-foreground">
        Budget estimé sur les {formatSurface(surface)} du bien (surface × prix moyen au m²). Aucun
        montant n’est retenu tant que vous n’avez pas choisi.
        {suggestionReason ? ` ${suggestionReason}` : ""}
      </p>

      <div
        className="mt-4 grid gap-2 @md:grid-cols-2 @2xl:grid-cols-4"
        role="radiogroup"
        aria-label="Étendue estimée des travaux"
      >
        {options.map((option) => (
          <button
            key={option.key ?? "none"}
            type="button"
            role="radio"
            aria-checked={option.checked}
            onClick={() => onSelect(option.key)}
            className={`flex min-h-11 flex-col rounded-lg border px-3 py-2.5 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              option.checked
                ? "border-gold bg-gold/[0.09] shadow-[0_0_0_1px_rgb(192_138_68/20%)]"
                : "border-border bg-white hover:border-gold/45 hover:bg-gold/[0.04]"
            }`}
          >
            <span className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
              <span className="text-sm font-semibold text-foreground">{option.label}</span>
              {option.checked ? (
                <span className="rounded-md bg-gold px-2 py-0.5 text-xs font-semibold text-brand-navy">
                  Retenu
                </span>
              ) : suggestedScenario === option.key ? (
                <span className="rounded-md border border-gold/40 px-2 py-0.5 text-xs font-semibold text-gold-text">
                  Suggéré
                </span>
              ) : null}
            </span>
            <span className="mt-1 text-xs text-muted-foreground">
              <strong className="text-sm tabular-nums text-foreground">{fmt(option.budget)}</strong>
              {option.rate ? ` · ${option.rate}` : null}
            </span>
          </button>
        ))}
      </div>

      {/* Le détail du seul scénario retenu : quatre descriptions côte à côte allongeaient la fiche. */}
      {selected || noWorksSelected ? (
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          {selected
            ? `${selected.summary} ${selected.scope}`
            : "Le bien est repris en l’état, sans budget de rénovation."}
        </p>
      ) : null}
    </div>
  );
}
