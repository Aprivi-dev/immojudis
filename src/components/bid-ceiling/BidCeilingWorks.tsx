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
          {fmt(maxWorks)}
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

export function WorksScenarioSelector({
  surface,
  works,
  selectedScenario,
  maxWorks,
  onSelect,
  onWorksChange,
}: {
  surface: number;
  works: number;
  selectedScenario: WorksScenarioKey | null;
  maxWorks: number | null;
  onSelect: (scenario: WorksScenarioKey | null) => void;
  onWorksChange: (works: number) => void;
}) {
  const selectedConfig = WORKS_SCENARIOS.find((scenario) => scenario.key === selectedScenario);
  const exceedsEnvelope = maxWorks != null && works > maxWorks;
  const retainedPricePerM2 = surface > 0 ? Math.round(works / surface) : 0;

  return (
    <div className="mt-5 rounded-lg border border-border bg-muted/35 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-gold-text">
            <Wrench className="h-4 w-4" />
            Estimation des travaux
          </div>
          <h3 className="mt-2 text-base font-semibold text-foreground">
            Quels travaux prévoyez-vous ?
          </h3>
          <p className="mt-1 max-w-3xl text-sm leading-relaxed text-muted-foreground">
            Aucun travaux n’est inclus tant que vous n’en choisissez pas. Le budget calculé sur les{" "}
            {formatSurface(surface)} du bien est affiché pour chaque scénario avant d’être déduit de
            votre enchère plafond.
          </p>
        </div>
        <span className="rounded-full border border-gold/25 bg-gold/10 px-3 py-1 text-xs font-semibold text-gold-text">
          Surface × prix moyen au m²
        </span>
      </div>

      <div
        className="mt-4 grid gap-3 lg:grid-cols-4"
        role="radiogroup"
        aria-label="Étendue estimée des travaux"
      >
        <button
          type="button"
          role="radio"
          aria-checked={selectedScenario == null && works === 0}
          onClick={() => onSelect(null)}
          className={`flex h-full flex-col rounded-lg border p-4 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
            selectedScenario == null && works === 0
              ? "border-gold bg-gold/[0.09] shadow-[0_0_0_1px_rgb(192_138_68/20%)]"
              : "border-border bg-white hover:border-gold/45 hover:bg-gold/[0.04]"
          }`}
        >
          <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Sans travaux
          </span>
          <span className="mt-3 text-base font-semibold text-foreground">Aucun travaux</span>
          <span className="mt-3 text-sm leading-relaxed text-muted-foreground">
            Le bien est repris en l’état, sans budget de rénovation.
          </span>
          <span className="mt-4 border-t border-border pt-3 text-xs text-muted-foreground">
            Pour ce bien : <strong className="text-sm tabular-nums text-foreground">0 €</strong>
          </span>
        </button>
        {WORKS_SCENARIOS.map((scenario, index) => {
          const selected = scenario.key === selectedScenario;
          const budget = estimateWorksBudget(surface, scenario.key);
          return (
            <button
              key={scenario.key}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onSelect(scenario.key)}
              className={`flex h-full flex-col rounded-lg border p-4 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                selected
                  ? "border-gold bg-gold/[0.09] shadow-[0_0_0_1px_rgb(192_138_68/20%)]"
                  : "border-border bg-white hover:border-gold/45 hover:bg-gold/[0.04]"
              }`}
            >
              <span className="flex items-start justify-between gap-3">
                <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  Scénario {index + 1}
                </span>
                {selected ? (
                  <span className="rounded-full bg-gold px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-brand-navy">
                    Retenu
                  </span>
                ) : null}
              </span>
              <span className="mt-3 text-base font-semibold text-foreground">{scenario.label}</span>
              <span className="mt-1 text-2xl font-semibold tabular-nums text-gold-text">
                {ppm2(scenario.pricePerM2)}
              </span>
              <span className="mt-3 text-sm leading-relaxed text-muted-foreground">
                {scenario.summary}
              </span>
              <span className="mt-2 text-xs leading-relaxed text-muted-foreground">
                {scenario.scope}
              </span>
              <span className="mt-4 border-t border-border pt-3 text-xs text-muted-foreground">
                Pour ce bien :{" "}
                <strong className="text-sm tabular-nums text-foreground">{fmt(budget)}</strong>
              </span>
            </button>
          );
        })}
      </div>

      <div
        className={`mt-4 grid gap-4 rounded-lg border p-4 sm:grid-cols-[1fr_190px] sm:items-end ${
          exceedsEnvelope
            ? "border-amber-300/40 bg-amber-50"
            : "border-emerald-300/30 bg-emerald-50/70"
        }`}
      >
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Budget travaux retenu
          </div>
          <div className="mt-1 text-2xl font-semibold tabular-nums text-foreground">
            {fmt(works)}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {selectedConfig
              ? `${formatSurface(surface)} × ${ppm2(selectedConfig.pricePerM2)}. Ce montant est déjà retranché du plafond affiché.`
              : works === 0
                ? "Aucun travaux inclus : le plafond affiché ne retranche aucun budget de rénovation."
                : `Montant personnalisé, soit environ ${ppm2(retainedPricePerM2)}. Il remplace l'estimation par scénario.`}
          </p>
          {exceedsEnvelope ? (
            <p className="mt-2 text-xs font-medium leading-relaxed text-amber-700">
              Ce budget dépasse de {fmt(works - maxWorks!)} l'enveloppe travaux compatible avec la
              mise simulée. L’enchère plafond baisse en conséquence.
            </p>
          ) : null}
        </div>
        <label className="block">
          <span className="text-xs font-medium text-muted-foreground">Remplacer par un devis</span>
          <div className="mt-1 flex items-center rounded-md border border-border bg-white focus-within:ring-1 focus-within:ring-ring">
            <input
              type="number"
              inputMode="decimal"
              min={0}
              step={500}
              value={Number.isFinite(works) ? works : 0}
              onChange={(event) => onWorksChange(parseFloat(event.target.value) || 0)}
              className="w-full bg-transparent px-3 py-2 text-sm tabular-nums outline-none"
              aria-label="Budget travaux personnalisé"
            />
            <span className="pr-3 text-xs text-muted-foreground">€</span>
          </div>
        </label>
      </div>
    </div>
  );
}
