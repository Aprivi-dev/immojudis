import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import FileSearch from "lucide-react/dist/esm/icons/file-search.js";
import Info from "lucide-react/dist/esm/icons/info.js";
import Target from "lucide-react/dist/esm/icons/target.js";
import {
  computeMarketCeiling,
  computeRecommendedCeilings,
  DEFAULTS,
  estimateWorksBudget,
  MARKET_CEILING_SCENARIOS,
} from "@/lib/profitability";
import { fetchPrecomputedMarketEstimate } from "@/lib/client-api";
import type { MarketEstimate as DvfMarketEstimate } from "@/lib/market.server";
import { formatSurface } from "@/lib/format";
import { getMarketValuationSurfaces, getSaleSurface } from "@/lib/surface";
import type { AuctionSale } from "@/lib/types";
import { useAuth } from "@/hooks/use-auth";
import { BidSimulationHistory } from "@/components/BidSimulationHistory";
import type { ReportSimulation } from "@/lib/report-simulation";
import {
  bidStorageKey,
  type BidAssistantState as AssistantState,
} from "@/lib/bid-simulation-history";
import { queryKeys } from "@/lib/query-keys";
import {
  type BidSimulationSnapshot,
  costInputsFromState,
  createAssistantState,
  fmt,
  loadState,
  ppm2,
  type ScenarioResult,
} from "@/components/bid-ceiling/assistant-state";
import { reliabilityLabel } from "@/components/bid-ceiling/BidCeilingShared";
import { WorksEnvelope, WorksScenarioSelector } from "@/components/bid-ceiling/BidCeilingWorks";
import {
  ComparableTransactions,
  MarketInput,
  MarketLocalCard,
  marketUnavailableReason,
} from "@/components/bid-ceiling/BidCeilingMarket";
import {
  AssistantHeader,
  buildNextAction,
  CeilingReferencePair,
  FeesBreakdown,
  HypothesisEditor,
  MethodCard,
  RangeBar,
  SimulationCard,
  SuccessConditions,
} from "@/components/bid-ceiling/BidCeilingResults";

export type { BidSimulationSnapshot } from "@/components/bid-ceiling/assistant-state";

export function BidCeilingAssistant({
  sale,
  marketEstimateOverride = null,
  onSimulationChange,
  initialSimulation,
}: {
  sale: AuctionSale;
  marketEstimateOverride?: DvfMarketEstimate | null;
  onSimulationChange?: (snapshot: BidSimulationSnapshot) => void;
  initialSimulation?: ReportSimulation;
}) {
  const { user, loading } = useAuth();
  if (loading)
    return (
      <p role="status" className="p-5 text-sm text-muted-foreground">
        Chargement du simulateur…
      </p>
    );
  const ownerId = user?.id ?? "guest-demo";
  return (
    <BidCeilingWorkspace
      key={`${ownerId}:${sale.id}`}
      sale={sale}
      marketEstimateOverride={marketEstimateOverride}
      ownerId={ownerId}
      onSimulationChange={onSimulationChange}
      initialSimulation={initialSimulation}
    />
  );
}

function BidCeilingWorkspace({
  sale,
  marketEstimateOverride,
  ownerId,
  onSimulationChange,
  initialSimulation,
}: {
  sale: AuctionSale;
  marketEstimateOverride: DvfMarketEstimate | null;
  ownerId: string;
  onSimulationChange?: (snapshot: BidSimulationSnapshot) => void;
  initialSimulation?: ReportSimulation;
}) {
  const draftKey = bidStorageKey("draft", ownerId, sale.id);
  const surfaceInfo = getSaleSurface(sale);
  const marketSurfaces = getMarketValuationSurfaces(sale);
  const surface = marketSurfaces.builtSurfaceM2;
  const valuationSurface = marketSurfaces.builtSurfaceM2 ?? marketSurfaces.landSurfaceM2;
  const startingPrice = sale.starting_price_eur ?? 0;
  const hasMarketEstimateOverride = marketEstimateOverride != null;

  const [detailsOpen, setDetailsOpen] = useState(false);
  const [state, setState] = useState<AssistantState>(() =>
    createAssistantState(
      startingPrice,
      surface,
      initialSimulation
        ? {
            ...loadState(draftKey),
            ...initialSimulation,
            worksScenario: null,
            manualMarketPricePerM2: initialSimulation.manualMarketPricePerM2 ?? 0,
            marketEdited: initialSimulation.manualMarketPricePerM2 != null,
          }
        : loadState(draftKey),
    ),
  );
  const [stateSaleId, setStateSaleId] = useState(sale.id);

  useEffect(() => {
    const stored = loadState(draftKey);
    setState(
      createAssistantState(
        startingPrice,
        surface,
        initialSimulation
          ? {
              ...stored,
              ...initialSimulation,
              worksScenario: null,
              manualMarketPricePerM2: initialSimulation.manualMarketPricePerM2 ?? 0,
              marketEdited: initialSimulation.manualMarketPricePerM2 != null,
            }
          : stored,
      ),
    );
    setStateSaleId(sale.id);
    // Page-level hypotheses are restored on mount. Subsequent edits belong to
    // this workspace and must not reset its inputs when it emits a snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey, sale.id, startingPrice, surface]);

  useEffect(() => {
    if (typeof window === "undefined" || stateSaleId !== sale.id) return;
    try {
      window.localStorage.setItem(draftKey, JSON.stringify(state));
    } catch {
      /* ignore quota errors */
    }
  }, [draftKey, sale.id, state, stateSaleId]);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.precomputedMarketEstimate(sale.id),
    queryFn: () => fetchPrecomputedMarketEstimate({ saleId: sale.id }),
    enabled: !hasMarketEstimateOverride,
    staleTime: 24 * 60 * 60_000,
    refetchInterval: (query) =>
      query.state.data?.status === "queued" && !query.state.data.estimate ? 15_000 : false,
  });

  const estimate = data?.estimate ?? null;
  const effectiveEstimate = marketEstimateOverride ?? estimate;
  const usingCachedEstimate = false;
  const hasDvfError = !hasMarketEstimateOverride && Boolean(error || data?.ok === false);
  const useManualMarket =
    state.marketEdited ||
    effectiveEstimate?.actionable !== true ||
    !effectiveEstimate.medianPricePerM2;

  const scenarioResults = useMemo<ScenarioResult[]>(
    () =>
      [
        ...MARKET_CEILING_SCENARIOS,
        {
          key: "custom" as const,
          label: "Personnalisé",
          description: "Marge choisie par l’utilisateur sur la référence prudente disponible.",
        },
      ].map((scenario) => ({
        key: scenario.key,
        label: scenario.label,
        description: scenario.description,
        result: computeMarketCeiling({
          surface,
          price: state.price,
          works: state.works,
          ...costInputsFromState(state, sale),
          scenario: scenario.key,
          customSafetyDiscountPct: state.customSafetyDiscountPct,
          manualMarketPricePerM2: useManualMarket ? state.manualMarketPricePerM2 : null,
          medianPricePerM2: effectiveEstimate?.medianPricePerM2,
          p10PricePerM2: effectiveEstimate?.p10PricePerM2,
          p25PricePerM2: effectiveEstimate?.p25PricePerM2,
          p75PricePerM2: effectiveEstimate?.p75PricePerM2,
        }),
      })),
    [effectiveEstimate, sale, state, surface, useManualMarket],
  );

  const selected =
    scenarioResults.find((item) => item.key === state.scenario) ?? scenarioResults[0];
  useEffect(() => {
    onSimulationChange?.({
      saleId: sale.id,
      ownerId,
      result: selected.result,
      works: state.works,
      worksKnown: surface != null || state.worksScenario == null,
      reportInput: {
        price: state.price,
        works: state.works,
        fpt: state.fpt,
        lawyerFees: state.lawyerFees ?? DEFAULTS.lawyerFees,
        registrationRate:
          state.registrationRatePct != null ? state.registrationRatePct / 100 : null,
        taxRegime: state.taxRegime ?? "registration",
        occupancyDiscountPct: state.occupancyDiscountPct ?? DEFAULTS.occupancyDiscountPct,
        carryMonths: state.carryMonths ?? DEFAULTS.occupancyCarryMonths,
        monthlyCarryCharges: state.monthlyCarryCharges ?? 0,
        scenario: state.scenario,
        customSafetyDiscountPct: state.customSafetyDiscountPct,
        manualMarketPricePerM2: useManualMarket ? state.manualMarketPricePerM2 : null,
        expectedMaxBid: selected.result.maxBid,
      },
    });
  }, [onSimulationChange, ownerId, sale.id, selected.result, state, surface, useManualMarket]);
  const recommendedCeilings = useMemo(
    () =>
      computeRecommendedCeilings({
        surface,
        price: state.price,
        ...costInputsFromState(state, sale),
        scenario: selected.key,
        customSafetyDiscountPct: state.customSafetyDiscountPct,
        manualMarketPricePerM2: useManualMarket ? state.manualMarketPricePerM2 : null,
        medianPricePerM2: effectiveEstimate?.medianPricePerM2,
        p10PricePerM2: effectiveEstimate?.p10PricePerM2,
        p25PricePerM2: effectiveEstimate?.p25PricePerM2,
        p75PricePerM2: effectiveEstimate?.p75PricePerM2,
      }),
    [effectiveEstimate, sale, selected.key, state, surface, useManualMarket],
  );
  const availableResults = scenarioResults
    .map((item) => item.result)
    .filter((item) => item.available);
  const minBid = availableResults.length
    ? Math.min(...availableResults.map((item) => item.maxBid))
    : null;
  const maxBid = availableResults.length
    ? Math.max(...availableResults.map((item) => item.maxBid))
    : null;
  const rangeLabel =
    minBid == null || maxBid == null
      ? "À compléter"
      : minBid === maxBid
        ? fmt(minBid)
        : `${fmt(minBid)} - ${fmt(maxBid)}`;
  const selectedMargin = selected.result.available
    ? selected.result.targetTotalCost - selected.result.simulated.totalCost
    : null;
  const reliability = reliabilityLabel(effectiveEstimate, useManualMarket);

  const reset = () => {
    setState(createAssistantState(startingPrice, surface));
  };

  const verdictAvailable = selected.result.available;
  const nextAction = buildNextAction(sale, verdictAvailable);

  if (!surface || surface <= 0) {
    return (
      <section className="rounded-lg border border-border bg-white p-5 shadow-sm">
        <AssistantHeader onReset={reset} />
        <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
          Immojudis ne peut pas calculer une enchère plafond fiable tant que la surface du bien
          n'est pas renseignée. Complétez la surface ou relisez les pièces pour obtenir une
          fourchette.
        </p>
      </section>
    );
  }

  return (
    <section className="overflow-hidden rounded-lg border border-border bg-white shadow-sm">
      <div className="p-5 sm:p-6">
        <AssistantHeader onReset={reset} />

        {/* ── 1. Le verdict, immédiatement ─────────────────────────────── */}
        <div className="mt-6 rounded-lg border border-gold/30 bg-gold/[0.07] p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-5">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-gold-text">
                <Target className="h-4 w-4" />
                Votre enchère plafond
              </div>
              <div className="mt-3 text-4xl font-semibold leading-none tabular-nums text-foreground sm:text-5xl">
                {verdictAvailable ? fmt(selected.result.maxBid) : "À compléter"}
              </div>
              <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">
                {verdictAvailable ? (
                  <>
                    Au-delà, le coût complet (enchère + frais + travaux) dépasse{" "}
                    <strong className="text-foreground">
                      {selected.result.safetyDiscountPct}% sous le marché local
                    </strong>{" "}
                    ({selected.result.basisLabel} :{" "}
                    {ppm2(selected.result.marketReferencePricePerM2)}) : le dossier perd son
                    intérêt.
                  </>
                ) : (
                  "Renseignez un prix de marché local juste en dessous pour obtenir votre plafond."
                )}
              </p>
            </div>

            <div className="flex flex-col items-end gap-2">
              {/* Sélecteur de profil */}
              <div
                className="flex max-w-full flex-wrap justify-end gap-1 rounded-2xl border border-border bg-white p-1 sm:rounded-full"
                role="radiogroup"
                aria-label="Profil d'enchère"
              >
                {scenarioResults.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    role="radio"
                    aria-checked={item.key === state.scenario}
                    onClick={() => setState((current) => ({ ...current, scenario: item.key }))}
                    className={`min-h-10 whitespace-nowrap rounded-full px-3.5 py-1.5 text-xs font-semibold transition ${
                      item.key === state.scenario
                        ? "bg-gold text-brand-navy"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              <span className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                Référence marché {reliability} · Surface{" "}
                {marketSurfaces.builtSurfaceEstimated
                  ? `${formatSurface(surface)} estimés`
                  : surfaceInfo.estimated
                    ? surfaceInfo.label
                    : formatSurface(surface)}
              </span>
            </div>
          </div>

          {state.scenario === "custom" ? (
            <label className="mb-5 grid gap-2 text-sm">
              Marge de sécurité personnalisée (%)
              <input
                type="range"
                min="0"
                max="40"
                step="1"
                value={state.customSafetyDiscountPct ?? 8}
                onChange={(event) =>
                  setState((current) => ({
                    ...current,
                    customSafetyDiscountPct: Math.min(40, Math.max(0, Number(event.target.value))),
                  }))
                }
              />
              <span>
                {state.customSafetyDiscountPct ?? 8} % sous la référence retenue. Cette hypothèse
                n’est pas une garantie de marge.
              </span>
            </label>
          ) : null}

          <CeilingReferencePair
            withoutWorks={recommendedCeilings.withoutWorks}
            withRefreshWorks={recommendedCeilings.withRefreshWorks}
            refreshWorksBudget={recommendedCeilings.refreshWorksBudget}
            profileLabel={selected.label}
          />

          {(surfaceInfo.estimated || marketSurfaces.builtSurfaceEstimated) && (
            <p className="mt-4 rounded-lg border border-gold/20 bg-gold/[0.06] px-3 py-2 text-xs leading-relaxed text-gold-text">
              {marketSurfaces.builtSurfaceAssumption ?? surfaceInfo.helperText}
            </p>
          )}

          {/* Barre de fourchette : prudent ↔ offensif + position de la mise à prix */}
          {verdictAvailable && minBid != null && maxBid != null && (
            <RangeBar
              minBid={minBid}
              maxBid={maxBid}
              selectedBid={selected.result.maxBid}
              startingPrice={startingPrice}
              rangeLabel={rangeLabel}
            />
          )}

          {/* Enveloppe travaux : combien engager en travaux en restant sous le
              seuil de marché, à la mise simulée (mise à prix par défaut). */}
          {verdictAvailable && (
            <WorksEnvelope
              maxWorks={selected.result.maxWorksAtSimulatedPrice}
              simulatedPrice={state.price}
              startingPrice={startingPrice}
            />
          )}

          {/* Marché manquant : la saisie arrive ici, pas cachée plus bas */}
          {!verdictAvailable && (
            <div className="mt-5">
              <MarketInput
                estimate={effectiveEstimate}
                value={state.manualMarketPricePerM2}
                marketEdited={state.marketEdited}
                usingCachedEstimate={usingCachedEstimate}
                isLoading={isLoading && !effectiveEstimate}
                hasError={hasDvfError && !effectiveEstimate}
                onChange={(manualMarketPricePerM2) =>
                  setState((current) => ({
                    ...current,
                    manualMarketPricePerM2,
                    marketEdited: manualMarketPricePerM2 > 0,
                  }))
                }
              />
            </div>
          )}

          {/* Prochaine action */}
          <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-border pt-4 text-sm">
            <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-gold-text">
              Prochaine action
            </span>
            <span className="text-muted-foreground">{nextAction}</span>
          </div>
        </div>

        {/* ── 2. Estimation des travaux ───────────────────────────────── */}
        <WorksScenarioSelector
          surface={surface}
          works={state.works}
          selectedScenario={state.worksScenario}
          maxWorks={selected.result.available ? selected.result.maxWorksAtSimulatedPrice : null}
          onSelect={(worksScenario) =>
            setState((current) => ({
              ...current,
              worksScenario,
              works: worksScenario ? estimateWorksBudget(surface, worksScenario) : 0,
            }))
          }
          onWorksChange={(works) =>
            setState((current) => ({ ...current, works, worksScenario: null }))
          }
        />

        <BidSimulationHistory
          ownerId={ownerId}
          saleId={sale.id}
          inputs={state}
          result={selected.result}
          onRestore={(snapshot) =>
            setState({
              ...snapshot.inputs,
              worksScenario:
                snapshot.inputs.worksScenario &&
                estimateWorksBudget(surface, snapshot.inputs.worksScenario) ===
                  snapshot.inputs.works
                  ? snapshot.inputs.worksScenario
                  : null,
            })
          }
        />

        {/* ── 3. Pourquoi ce chiffre ───────────────────────────────────── */}
        <div className="mt-5">
          <MethodCard result={selected.result} estimate={effectiveEstimate} />
        </div>

        {/* ── 3b. Marché local (DVF parcellaire + historique adresse) ──── */}
        <MarketLocalCard
          estimate={effectiveEstimate}
          usingCachedEstimate={usingCachedEstimate}
          isLoading={isLoading && !effectiveEstimate}
          valuationSurface={valuationSurface}
          unavailableReason={marketUnavailableReason({
            valuationSurface,
            isLand: marketSurfaces.surfaceKind === "land",
            hasDvfError,
            storedError: data?.error ?? null,
          })}
        />

        {/* ── 4. Conditions pour rester gagnant ────────────────────────── */}
        <SuccessConditions
          sale={sale}
          result={selected.result}
          estimate={effectiveEstimate}
          useManualMarket={useManualMarket}
        />

        {/* ── 5. Ajuster mes hypothèses (replié par défaut) ────────────── */}
        <button
          type="button"
          aria-expanded={detailsOpen}
          onClick={() => setDetailsOpen((current) => !current)}
          className="mt-5 inline-flex items-center gap-2 text-sm font-medium text-gold-text transition-colors hover:text-gold-text"
        >
          <FileSearch className="h-4 w-4" />
          {detailsOpen
            ? "Masquer les réglages et le détail"
            : "Ajuster mes hypothèses (travaux, frais, marché) et voir le détail"}
        </button>

        {detailsOpen && (
          <div className="mt-4 space-y-4">
            {verdictAvailable && (
              <MarketInput
                estimate={effectiveEstimate}
                value={state.manualMarketPricePerM2}
                marketEdited={state.marketEdited}
                usingCachedEstimate={usingCachedEstimate}
                isLoading={isLoading && !effectiveEstimate}
                hasError={hasDvfError && !effectiveEstimate}
                onChange={(manualMarketPricePerM2) =>
                  setState((current) => ({
                    ...current,
                    manualMarketPricePerM2,
                    marketEdited: manualMarketPricePerM2 > 0,
                  }))
                }
              />
            )}
            <HypothesisEditor
              state={state}
              startingPrice={startingPrice}
              result={selected.result}
              onChange={setState}
            />
            <div className="grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
              <SimulationCard result={selected.result} selectedMargin={selectedMargin} />
              <FeesBreakdown result={selected.result} fpt={state.fpt} onChange={setState} />
            </div>
            <ComparableTransactions estimate={effectiveEstimate} />
          </div>
        )}

        <p className="mt-5 flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gold-text" />
          Ce plafond est une aide à la décision : il intègre enchère, frais estimés, FPT, travaux et
          marge de sécurité. Il ne remplace pas la relecture des pièces ni l'avis d'un
          professionnel.
        </p>
      </div>
    </section>
  );
}
