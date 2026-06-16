import { useEffect, useMemo, useState } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import Calculator from "lucide-react/dist/esm/icons/calculator.js";
import CheckCircle2 from "lucide-react/dist/esm/icons/check-circle-2.js";
import FileSearch from "lucide-react/dist/esm/icons/file-search.js";
import Home from "lucide-react/dist/esm/icons/home.js";
import Info from "lucide-react/dist/esm/icons/info.js";
import MapPin from "lucide-react/dist/esm/icons/map-pin.js";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import Target from "lucide-react/dist/esm/icons/target.js";
import TrendingDown from "lucide-react/dist/esm/icons/trending-down.js";
import Wrench from "lucide-react/dist/esm/icons/wrench.js";
import {
  computeMarketCeiling,
  DEFAULTS,
  MARKET_CEILING_SCENARIOS,
  type MarketCeilingResult,
  type MarketCeilingScenarioKey,
} from "@/lib/profitability";
import {
  getMarketEstimate,
  type MarketEstimate as DvfMarketEstimate,
} from "@/lib/market.functions";
import {
  documentTypeLabel,
  formatDate,
  formatPrice,
  formatPricePerM2,
  formatSurface,
  occupancyLabel,
} from "@/lib/format";
import { getSaleSurface } from "@/lib/surface";
import type { AuctionSale, SaleRisk } from "@/lib/types";

type AssistantState = {
  price: number;
  works: number;
  fpt: number;
  scenario: MarketCeilingScenarioKey;
  manualMarketPricePerM2: number;
  marketEdited: boolean;
};

type ScenarioResult = {
  key: MarketCeilingScenarioKey;
  label: string;
  description: string;
  result: MarketCeilingResult;
};

const MARKET_ESTIMATE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type CachedMarketEstimatePayload = {
  savedAt: number;
  estimate: DvfMarketEstimate;
};

function storageKey(saleId: string) {
  return `bid-ceiling-assistant:${saleId}`;
}

function marketEstimateCacheKey(saleId: string) {
  return `market-estimate:${saleId}`;
}

function loadState(saleId: string): Partial<AssistantState> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(storageKey(saleId));
    if (!raw) return null;
    return JSON.parse(raw) as Partial<AssistantState>;
  } catch {
    return null;
  }
}

function loadCachedMarketEstimate(saleId: string): DvfMarketEstimate | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(marketEstimateCacheKey(saleId));
    if (!raw) return null;
    const payload = JSON.parse(raw) as Partial<CachedMarketEstimatePayload>;
    if (!payload.savedAt || !payload.estimate) return null;
    if (Date.now() - payload.savedAt > MARKET_ESTIMATE_CACHE_TTL_MS) return null;
    return payload.estimate;
  } catch {
    return null;
  }
}

function saveCachedMarketEstimate(saleId: string, estimate: DvfMarketEstimate) {
  if (typeof window === "undefined") return;
  try {
    const payload: CachedMarketEstimatePayload = { savedAt: Date.now(), estimate };
    window.localStorage.setItem(marketEstimateCacheKey(saleId), JSON.stringify(payload));
  } catch {
    /* ignore quota errors */
  }
}

function fmt(value: number): string {
  return formatPrice(Math.round(value || 0));
}

function ppm2(value: number | null | undefined): string {
  return formatPricePerM2(value);
}

function signedMoney(value: number): string {
  const rounded = Math.round(value || 0);
  if (rounded === 0) return "0 €";
  return `${rounded > 0 ? "+" : "-"}${fmt(Math.abs(rounded))}`;
}

export function BidCeilingAssistant({ sale }: { sale: AuctionSale }) {
  const surfaceInfo = getSaleSurface(sale);
  const surface = surfaceInfo.value;
  const startingPrice = sale.starting_price_eur ?? 0;
  const fetchEstimate = useServerFn(getMarketEstimate);

  const [detailsOpen, setDetailsOpen] = useState(false);
  const [cachedEstimate, setCachedEstimate] = useState<DvfMarketEstimate | null>(() =>
    loadCachedMarketEstimate(sale.id),
  );
  const [state, setState] = useState<AssistantState>(() => ({
    price: startingPrice,
    works: 0,
    fpt: DEFAULTS.fpt,
    scenario: "equilibre",
    manualMarketPricePerM2: 0,
    marketEdited: false,
  }));

  useEffect(() => {
    const stored = loadState(sale.id);
    if (stored) setState((current) => ({ ...current, ...stored }));
    setCachedEstimate(loadCachedMarketEstimate(sale.id));
  }, [sale.id]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(storageKey(sale.id), JSON.stringify(state));
    } catch {
      /* ignore quota errors */
    }
  }, [sale.id, state]);

  const { data, isLoading, error } = useQuery({
    queryKey: [
      "market-estimate",
      sale.id,
      sale.latitude,
      sale.longitude,
      sale.property_type,
      Math.round(surface ?? 0),
    ],
    queryFn: () =>
      fetchEstimate({
        data: {
          lat: sale.latitude!,
          lng: sale.longitude!,
          // Rayon auto-déduit côté serveur : 100 m en ville, 300 m en campagne.
          propertyType: sale.property_type,
          surfaceM2: surface,
        },
      }),
    enabled: sale.latitude != null && sale.longitude != null && surface != null && surface > 0,
    staleTime: 24 * 60 * 60_000,
  });

  const estimate = data?.estimate ?? null;
  useEffect(() => {
    if (!estimate) return;
    saveCachedMarketEstimate(sale.id, estimate);
    setCachedEstimate(estimate);
  }, [sale.id, estimate]);

  const effectiveEstimate = estimate ?? cachedEstimate;
  const usingCachedEstimate = !estimate && Boolean(cachedEstimate);
  const hasDvfError = Boolean(error || data?.ok === false);
  const useManualMarket = state.marketEdited || !effectiveEstimate?.medianPricePerM2;

  const scenarioResults = useMemo<ScenarioResult[]>(
    () =>
      MARKET_CEILING_SCENARIOS.map((scenario) => ({
        key: scenario.key,
        label: scenario.label,
        description: scenario.description,
        result: computeMarketCeiling({
          surface,
          price: state.price,
          works: state.works,
          fpt: state.fpt,
          scenario: scenario.key,
          manualMarketPricePerM2: useManualMarket ? state.manualMarketPricePerM2 : null,
          medianPricePerM2: effectiveEstimate?.medianPricePerM2,
          p25PricePerM2: effectiveEstimate?.p25PricePerM2,
          p75PricePerM2: effectiveEstimate?.p75PricePerM2,
        }),
      })),
    [effectiveEstimate, state, surface, useManualMarket],
  );

  const selected =
    scenarioResults.find((item) => item.key === state.scenario) ?? scenarioResults[1];
  const balanced = scenarioResults.find((item) => item.key === "equilibre") ?? selected;
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
  const reliability = reliabilityLabel(effectiveEstimate, sale, useManualMarket);

  const reset = () => {
    if (typeof window !== "undefined") window.localStorage.removeItem(storageKey(sale.id));
    setState({
      price: startingPrice,
      works: 0,
      fpt: DEFAULTS.fpt,
      scenario: "equilibre",
      manualMarketPricePerM2: 0,
      marketEdited: false,
    });
  };

  const verdictAvailable = selected.result.available;
  const nextAction = buildNextAction(sale, verdictAvailable);

  if (!surface || surface <= 0) {
    return (
      <section className="liquid-panel rounded-lg p-5">
        <AssistantHeader onReset={reset} />
        <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
          Immojudis ne peut pas calculer une mise plafond fiable tant que la surface du bien n'est
          pas renseignée. Complète la surface ou relis les pièces pour obtenir une fourchette.
        </p>
      </section>
    );
  }

  return (
    <section className="liquid-panel overflow-hidden rounded-lg">
      <div className="p-5 sm:p-6">
        <AssistantHeader onReset={reset} />

        {/* ── 1. Le verdict, immédiatement ─────────────────────────────── */}
        <div className="mt-6 rounded-lg border border-gold/30 bg-gold/[0.07] p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-5">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.22em] text-gold">
                <Target className="h-4 w-4" />
                Votre mise plafond
              </div>
              <div className="mt-3 font-display text-4xl leading-none tabular-nums text-foreground sm:text-5xl">
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
                className="inline-flex rounded-full border border-white/12 bg-black/20 p-1"
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
                    className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition ${
                      item.key === state.scenario
                        ? "bg-gold text-background"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              <span className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                Fiabilité {reliability} · Surface{" "}
                {surfaceInfo.estimated ? surfaceInfo.label : formatSurface(surface)}
              </span>
            </div>
          </div>

          {surfaceInfo.estimated && (
            <p className="mt-4 rounded-lg border border-gold/20 bg-gold/[0.06] px-3 py-2 text-xs leading-relaxed text-gold-soft">
              {surfaceInfo.helperText}
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
          <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-white/10 pt-4 text-sm">
            <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-gold-soft">
              Prochaine action
            </span>
            <span className="text-muted-foreground">{nextAction}</span>
          </div>
        </div>

        {/* ── 2. Pourquoi ce chiffre ───────────────────────────────────── */}
        <div className="mt-5">
          <MethodCard result={balanced.result} estimate={effectiveEstimate} />
        </div>

        {/* ── 2b. Marché local (DVF parcellaire + historique adresse) ──── */}
        <MarketLocalCard
          estimate={effectiveEstimate}
          usingCachedEstimate={usingCachedEstimate}
          isLoading={isLoading && !effectiveEstimate}
        />

        {/* ── 3. Conditions pour rester gagnant ────────────────────────── */}
        <SuccessConditions
          sale={sale}
          result={selected.result}
          estimate={effectiveEstimate}
          useManualMarket={useManualMarket}
        />

        {/* ── 4. Ajuster mes hypothèses (replié par défaut) ────────────── */}
        <button
          type="button"
          aria-expanded={detailsOpen}
          onClick={() => setDetailsOpen((current) => !current)}
          className="mt-5 inline-flex items-center gap-2 text-sm font-medium text-gold-soft transition-colors hover:text-gold"
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
            <HypothesisEditor state={state} startingPrice={startingPrice} onChange={setState} />
            <div className="grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
              <SimulationCard result={selected.result} selectedMargin={selectedMargin} />
              <FeesBreakdown result={selected.result} fpt={state.fpt} onChange={setState} />
            </div>
            <ComparableTransactions estimate={effectiveEstimate} />
          </div>
        )}

        <p className="mt-5 flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gold" />
          Ce plafond est une aide à la décision : il intègre enchère, frais estimés, FPT, travaux et
          marge de sécurité. Il ne remplace pas la relecture des pièces ni l'avis d'un
          professionnel.
        </p>
      </div>
    </section>
  );
}

/**
 * Visual range bar: where the prudent→offensif ceilings sit, where the selected
 * profile lands, and where the mise à prix stands relative to the range.
 */
function RangeBar({
  minBid,
  maxBid,
  selectedBid,
  startingPrice,
  rangeLabel,
}: {
  minBid: number;
  maxBid: number;
  selectedBid: number;
  startingPrice: number;
  rangeLabel: string;
}) {
  // Scale with 12% padding on both sides so markers near the edges stay visible.
  const span = Math.max(1, maxBid - minBid);
  const lo = minBid - span * 0.12;
  const hi = maxBid + span * 0.12;
  const pos = (value: number) => `${Math.min(100, Math.max(0, ((value - lo) / (hi - lo)) * 100))}%`;
  const startBelowRange = startingPrice > 0 && startingPrice < minBid;

  return (
    <div className="mt-6">
      <div className="flex items-baseline justify-between text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
        <span>Fourchette selon votre profil</span>
        <span className="tabular-nums">{rangeLabel}</span>
      </div>
      <div className="relative mt-6 h-2 rounded-full bg-white/8">
        <div
          className="absolute inset-y-0 rounded-full bg-gradient-to-r from-[var(--signal-opportunity)] via-gold to-[var(--signal-watch)]"
          style={{ left: pos(minBid), right: `calc(100% - ${pos(maxBid)})` }}
          aria-hidden
        />
        {/* Repère du profil sélectionné */}
        <span
          className="absolute top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background bg-gold shadow-[0_0_0_3px_rgb(242_196_135/30%)]"
          style={{ left: pos(selectedBid) }}
          title={`Votre plafond : ${fmt(selectedBid)}`}
          aria-hidden
        />
        {/* Repère mise à prix */}
        {startingPrice > 0 && (
          <span
            className="absolute -top-5 -translate-x-1/2 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground"
            style={{ left: pos(startingPrice) }}
            aria-hidden
          >
            ▾ mise à prix
          </span>
        )}
      </div>
      <div className="mt-2 flex justify-between text-[11px] text-muted-foreground">
        <span>
          Prudent <strong className="tabular-nums text-foreground">{fmt(minBid)}</strong>
        </span>
        <span>
          Offensif <strong className="tabular-nums text-foreground">{fmt(maxBid)}</strong>
        </span>
      </div>
      {startBelowRange && (
        <p className="mt-3 text-xs leading-relaxed text-[var(--signal-opportunity)]">
          La mise à prix démarre sous votre fourchette : le dossier offre une vraie marge de
          manœuvre en salle.
        </p>
      )}
    </div>
  );
}

/**
 * Works envelope: the maximum renovation budget that still keeps the all-in cost
 * (purchase + fees + works) under the scenario's market threshold, at the
 * simulated bid. Defaults to the starting price; shrinks as the bid rises.
 */
function WorksEnvelope({
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
    <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-3 rounded-lg border border-white/10 bg-white/[0.04] p-4">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-gold/30 bg-gold/10 text-gold">
        <Wrench className="h-5 w-5" />
      </span>
      <div className="min-w-0">
        <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-gold-soft">
          Enveloppe travaux maximale
        </div>
        <div className="mt-1 font-display text-3xl leading-none tabular-nums text-foreground">
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

/** Single concrete next step before the hearing, derived from the dossier. */
function buildNextAction(sale: AuctionSale, verdictAvailable: boolean): string {
  if (!verdictAvailable) {
    return "Renseignez le prix de marché local pour obtenir votre plafond.";
  }
  const occupancy = (sale.occupancy_status ?? "").toLowerCase();
  if (!sale.occupancy_status || occupancy === "unknown") {
    return "Confirmez l'occupation du bien (PV descriptif) avant de figer votre plafond.";
  }
  const risks = sale.risks ?? [];
  const worksRisk = risks.find((risk) =>
    `${risk.risk_label ?? ""} ${risk.risk_type ?? ""}`.toLowerCase().match(/travaux|renov/),
  );
  if (worksRisk) {
    return "Chiffrez les travaux et reportez-les dans les hypothèses pour affiner le plafond.";
  }
  if ((sale.documents_rich?.length ?? 0) > 0) {
    return "Relisez le cahier des conditions de vente avec ce plafond en tête.";
  }
  return "Visitez le bien si possible, puis validez votre plafond avant l'audience.";
}

function AssistantHeader({ onReset }: { onReset: () => void }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex items-center gap-3">
        <span className="grid h-10 w-10 place-items-center rounded-lg border border-gold/30 bg-gold/10 text-gold">
          <Calculator className="h-5 w-5" />
        </span>
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">
            Assistant d'enchère
          </div>
          <h2 className="mt-1 text-lg font-semibold text-foreground">
            Déterminer une mise maximum défendable
          </h2>
        </div>
      </div>
      <button
        type="button"
        onClick={onReset}
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        title="Réinitialiser"
      >
        <RotateCcw className="h-3.5 w-3.5" />
        Réinitialiser
      </button>
    </div>
  );
}

function MarketInput({
  estimate,
  value,
  marketEdited,
  usingCachedEstimate,
  isLoading,
  hasError,
  onChange,
}: {
  estimate: DvfMarketEstimate | null;
  value: number;
  marketEdited: boolean;
  usingCachedEstimate: boolean;
  isLoading: boolean;
  hasError: boolean;
  onChange: (value: number) => void;
}) {
  const automaticPrice = estimate?.medianPricePerM2 ?? null;
  const needsManual = hasError || !automaticPrice;
  const helper = needsManual
    ? "Le marché local manque de comparables solides. Saisis un prix au m² réaliste pour obtenir un plafond provisoire."
    : marketEdited
      ? `Prix saisi utilisé à la place de la médiane DVF (${ppm2(automaticPrice)}). Efface le champ pour revenir au calcul automatique.`
      : usingCachedEstimate
        ? `Dernière estimation DVF conservée : médiane ${ppm2(automaticPrice)}.`
        : `Calcul automatique actif : médiane DVF ${ppm2(automaticPrice)}.`;

  return (
    <div
      className={`rounded-lg border p-4 ${
        needsManual ? "border-amber-300/25 bg-amber-400/10" : "border-white/10 bg-white/[0.04]"
      }`}
    >
      <div className="grid gap-3 sm:grid-cols-[1fr_180px] sm:items-end">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-gold">
            <MapPin className="h-4 w-4" />
            Prix de marché local
          </div>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {isLoading ? "Recherche des ventes DVF proches en cours..." : helper}
          </p>
        </div>
        <label className="block">
          <span className="text-xs font-medium text-muted-foreground">Saisie manuelle</span>
          <div className="mt-1 flex items-center rounded-md border border-white/10 bg-black/15 focus-within:ring-1 focus-within:ring-ring">
            <input
              type="number"
              inputMode="decimal"
              min={0}
              step={50}
              value={value > 0 ? value : ""}
              placeholder={automaticPrice ? String(Math.round(automaticPrice)) : "ex. 3 200"}
              onChange={(event) => onChange(parseFloat(event.target.value) || 0)}
              className="w-full bg-transparent px-3 py-2 text-sm tabular-nums outline-none placeholder:text-muted-foreground/60"
            />
            <span className="pr-3 text-xs text-muted-foreground">€/m²</span>
          </div>
        </label>
      </div>
    </div>
  );
}

function MarketLocalCard({
  estimate,
  usingCachedEstimate,
  isLoading,
}: {
  estimate: DvfMarketEstimate | null;
  usingCachedEstimate: boolean;
  isLoading: boolean;
}) {
  const areaLabel = estimate?.areaKind === "urban" ? "ville" : "campagne";
  const hasRange = Boolean(estimate?.medianPricePerM2);

  return (
    <div className="mt-5 rounded-lg border border-white/10 bg-white/[0.04] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-gold">
          <MapPin className="h-4 w-4" />
          Marché local
        </div>
        {estimate && (
          <span className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
            {estimate.commune ? `${estimate.commune} · ` : ""}rayon {estimate.radiusM} m (
            {areaLabel})
          </span>
        )}
      </div>

      {isLoading && !estimate ? (
        <p className="mt-3 text-sm text-muted-foreground">
          Lecture des ventes DVF par parcelle autour de l'adresse...
        </p>
      ) : !hasRange ? (
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          Pas assez de ventes exploitables autour de l'adresse pour établir une fourchette fiable.
          Saisis un prix de marché au m² dans les réglages pour obtenir un plafond provisoire.
        </p>
      ) : (
        <>
          <PriceRange estimate={estimate!} />
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
            Fourchette établie sur{" "}
            <strong className="text-foreground">{estimate!.sampleSize}</strong> parcelle
            {estimate!.sampleSize > 1 ? "s" : ""} bâtie{estimate!.sampleSize > 1 ? "s" : ""} (une
            vente par parcelle), sur {estimate!.totalNearbySampleSize} ventes recensées dans le
            rayon.
            {usingCachedEstimate ? " Estimation conservée en cache." : ""}
          </p>
          {estimate!.qualityWarnings.length > 0 && (
            <p className="mt-2 rounded-md border border-amber-300/20 bg-amber-400/10 px-3 py-2 text-xs leading-relaxed text-amber-100">
              {estimate!.qualityWarnings.join(" · ")}.
            </p>
          )}
        </>
      )}

      <AddressHistory estimate={estimate} />
    </div>
  );
}

function PriceRange({ estimate }: { estimate: DvfMarketEstimate }) {
  const min = estimate.minPricePerM2 ?? estimate.p25PricePerM2 ?? 0;
  const max = estimate.maxPricePerM2 ?? estimate.p75PricePerM2 ?? 0;
  const p25 = estimate.p25PricePerM2 ?? min;
  const p75 = estimate.p75PricePerM2 ?? max;
  const median = estimate.medianPricePerM2 ?? Math.round((p25 + p75) / 2);
  const span = Math.max(1, max - min);
  const pos = (v: number) => `${Math.min(100, Math.max(0, ((v - min) / span) * 100))}%`;

  return (
    <div className="mt-4">
      <div className="flex items-baseline justify-between text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
        <span>Prix au m² observé</span>
        <span className="tabular-nums">
          médiane <strong className="text-foreground">{ppm2(median)}</strong>
        </span>
      </div>
      <div className="relative mt-5 h-2 rounded-full bg-white/8">
        {/* Zone interquartile p25–p75 */}
        <div
          className="absolute inset-y-0 rounded-full bg-gradient-to-r from-[var(--signal-opportunity)] to-[var(--signal-watch)]"
          style={{ left: pos(p25), right: `calc(100% - ${pos(p75)})` }}
          aria-hidden
        />
        {/* Médiane */}
        <span
          className="absolute top-1/2 h-4 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground"
          style={{ left: pos(median) }}
          title={`Médiane ${ppm2(median)}`}
          aria-hidden
        />
      </div>
      <div className="mt-2 flex justify-between text-[11px] tabular-nums text-muted-foreground">
        <span>min {ppm2(min)}</span>
        <span>
          p25 {ppm2(p25)} · p75 {ppm2(p75)}
        </span>
        <span>max {ppm2(max)}</span>
      </div>
    </div>
  );
}

function AddressHistory({ estimate }: { estimate: DvfMarketEstimate | null }) {
  const history = estimate?.addressHistory ?? [];
  return (
    <div className="mt-4 border-t border-white/10 pt-4">
      <div className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
        Historique de l'adresse
      </div>
      {history.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">
          Aucune vente connue à cette adresse dans les données DVF récentes.
        </p>
      ) : (
        <ul className="mt-2 divide-y divide-white/10 text-sm">
          {history.map((sale, index) => (
            <li
              key={`${sale.date}-${sale.totalPrice}-${index}`}
              className="grid grid-cols-[auto_1fr_auto] items-baseline gap-3 py-2"
            >
              <span className="tabular-nums text-muted-foreground">{formatDate(sale.date)}</span>
              <span className="tabular-nums text-foreground">
                {fmt(sale.totalPrice)}
                {sale.surface ? (
                  <span className="text-muted-foreground"> · {formatSurface(sale.surface)}</span>
                ) : null}
              </span>
              <span className="tabular-nums text-muted-foreground">
                {sale.pricePerM2 ? ppm2(sale.pricePerM2) : "—"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function HypothesisEditor({
  state,
  startingPrice,
  onChange,
}: {
  state: AssistantState;
  startingPrice: number;
  onChange: Dispatch<SetStateAction<AssistantState>>;
}) {
  return (
    <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
      <Field
        label="Mise simulée"
        suffix="€"
        value={state.price}
        onChange={(price) => onChange((current) => ({ ...current, price }))}
        hint={`Mise à prix : ${formatPrice(startingPrice)}`}
      />
      <Field
        label="Travaux à provisionner"
        suffix="€"
        value={state.works}
        onChange={(works) => onChange((current) => ({ ...current, works }))}
        hint="À retirer du plafond"
      />
      <Field
        label="Frais préalables taxés"
        suffix="€"
        value={state.fpt}
        onChange={(fpt) => onChange((current) => ({ ...current, fpt }))}
        hint="Hypothèse ajustable"
      />
    </div>
  );
}

function SimulationCard({
  result,
  selectedMargin,
}: {
  result: MarketCeilingResult;
  selectedMargin: number | null;
}) {
  const positive = selectedMargin != null && selectedMargin >= 0;
  return (
    <div
      className={`rounded-lg border p-4 ${
        positive ? "border-emerald-300/20 bg-emerald-400/10" : "border-amber-300/25 bg-amber-400/10"
      }`}
    >
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
        <TrendingDown className="h-4 w-4 text-gold" />
        Test de la mise simulée
      </div>
      <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-3xl font-semibold tabular-nums text-foreground">
            {result.available ? fmt(result.simulated.totalCost) : "À compléter"}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            coût complet : enchère, frais, FPT et travaux
          </p>
        </div>
        <div className="text-right">
          <div className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
            Marge restante
          </div>
          <div className="mt-1 text-xl font-semibold tabular-nums text-foreground">
            {selectedMargin == null ? "À compléter" : signedMoney(selectedMargin)}
          </div>
        </div>
      </div>
      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
        {result.available
          ? positive
            ? "La mise simulée reste dans la zone défendable du scénario sélectionné."
            : "La mise simulée dépasse la zone défendable : il faut baisser l'enchère ou justifier une meilleure hypothèse de marché."
          : "Ajoute un prix de marché local pour savoir si la mise simulée reste défendable."}
      </p>
    </div>
  );
}

function MethodCard({
  result,
  estimate,
}: {
  result: MarketCeilingResult;
  estimate: DvfMarketEstimate | null;
}) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.04] p-4">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-gold">
        <ShieldCheck className="h-4 w-4" />
        Raisonnement retenu
      </div>
      <ol className="mt-3 grid gap-2 text-sm leading-relaxed text-muted-foreground sm:grid-cols-3">
        <MethodStep
          index="1"
          title="Marché"
          text={
            result.available
              ? `${result.basisLabel} : ${ppm2(result.marketReferencePricePerM2)}.`
              : "Prix local à compléter."
          }
        />
        <MethodStep
          index="2"
          title="Marge"
          text={
            result.available
              ? `${result.safetyDiscountPct}% retirés pour rester sous le marché.`
              : "La marge évite d'acheter au prix d'une vente classique."
          }
        />
        <MethodStep
          index="3"
          title="Plafond"
          text={
            result.available
              ? `Frais et travaux déduits : ${fmt(result.maxBid)}.`
              : "Le plafond sort dès que le marché est connu."
          }
        />
      </ol>
      {estimate?.qualityWarnings?.length ? (
        <p className="mt-3 rounded-md border border-amber-300/20 bg-amber-400/10 px-3 py-2 text-xs leading-relaxed text-amber-100">
          Prudence sur la référence locale : {estimate.qualityWarnings.join(", ")}.
        </p>
      ) : null}
    </div>
  );
}

function SuccessConditions({
  sale,
  result,
  estimate,
  useManualMarket,
}: {
  sale: AuctionSale;
  result: MarketCeilingResult;
  estimate: DvfMarketEstimate | null;
  useManualMarket: boolean;
}) {
  const conditions = buildSuccessConditions(sale, result, estimate, useManualMarket);
  return (
    <div className="mt-5 rounded-lg border border-white/10 bg-white/[0.03] p-4">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-gold">
        <CheckCircle2 className="h-4 w-4" />
        Conditions pour rester gagnant
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        {conditions.map((condition) => (
          <div key={condition.title} className="rounded-lg border border-white/10 bg-black/10 p-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <span className="text-gold">{condition.icon}</span>
              {condition.title}
            </div>
            <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{condition.text}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function FeesBreakdown({
  result,
  fpt,
  onChange,
}: {
  result: MarketCeilingResult;
  fpt: number;
  onChange: Dispatch<SetStateAction<AssistantState>>;
}) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.04] p-4">
      <div className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
        Frais retenus
      </div>
      <dl className="mt-3 grid gap-2 text-sm">
        <Row label="Émoluments avocat HT" value={fmt(result.simulated.emolumentsHT)} />
        <Row
          label="TVA sur émoluments"
          value={fmt(result.simulated.emolumentsTTC - result.simulated.emolumentsHT)}
        />
        <Row label="Droits d'enregistrement" value={fmt(result.simulated.registrationDuties)} />
        <Row
          label="FPT"
          value={fmt(result.simulated.fpt)}
          editable
          current={fpt}
          onEdit={(value) => onChange((current) => ({ ...current, fpt: value }))}
        />
        <Row label="Travaux" value={fmt(result.simulated.works)} />
        <Row
          label="Total frais hors travaux"
          value={fmt(result.simulated.acquisitionFeesTotal)}
          bold
        />
      </dl>
    </div>
  );
}

function ComparableTransactions({ estimate }: { estimate: DvfMarketEstimate | null }) {
  if (!estimate || estimate.recentTransactions.length === 0) {
    return (
      <div className="rounded-lg border border-white/10 bg-white/[0.04] p-4 text-sm text-muted-foreground">
        Aucune transaction comparable détaillée à afficher pour le moment.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.04] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
          Transactions DVF utilisées
        </div>
        <div className="text-xs text-muted-foreground">
          {estimate.sampleSize} ventes, rayon {estimate.radiusM} m
        </div>
      </div>
      <ul className="mt-3 divide-y divide-white/10 text-xs">
        {estimate.recentTransactions.map((transaction, index) => (
          <li
            key={`${transaction.date}-${transaction.totalPrice}-${index}`}
            className="grid grid-cols-4 gap-2 py-2"
          >
            <span className="text-muted-foreground">{formatDate(transaction.date)}</span>
            <span>{formatSurface(transaction.surface)}</span>
            <span className="font-medium tabular-nums">{fmt(transaction.totalPrice)}</span>
            <span className="text-right font-semibold tabular-nums">
              {ppm2(transaction.pricePerM2)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  suffix,
  hint,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  suffix?: string;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="mt-1 flex items-center rounded-md border border-white/10 bg-white/[0.05] focus-within:ring-1 focus-within:ring-ring">
        <input
          type="number"
          inputMode="decimal"
          step={1}
          value={Number.isFinite(value) ? value : 0}
          onChange={(event) => onChange(parseFloat(event.target.value) || 0)}
          className="w-full bg-transparent px-3 py-2 text-sm tabular-nums outline-none"
        />
        {suffix && <span className="pr-3 text-xs text-muted-foreground">{suffix}</span>}
      </div>
      {hint && <span className="mt-1 block text-[11px] text-muted-foreground">{hint}</span>}
    </label>
  );
}

function MethodStep({ index, title, text }: { index: string; title: string; text: string }) {
  return (
    <li className="rounded-md border border-white/10 bg-black/10 p-3">
      <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
        <span className="grid h-5 w-5 place-items-center rounded-full bg-gold text-[11px] text-background">
          {index}
        </span>
        {title}
      </div>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{text}</p>
    </li>
  );
}

function Row({
  label,
  value,
  bold,
  editable,
  current,
  onEdit,
}: {
  label: string;
  value: string;
  bold?: boolean;
  editable?: boolean;
  current?: number;
  onEdit?: (value: number) => void;
}) {
  return (
    <div
      className={`flex items-center justify-between gap-3 ${
        bold ? "border-t border-white/10 pt-2 font-semibold" : ""
      }`}
    >
      <dt className="text-muted-foreground">{label}</dt>
      {editable && onEdit ? (
        <input
          type="number"
          value={current ?? 0}
          onChange={(event) => onEdit(parseFloat(event.target.value) || 0)}
          className="w-24 rounded border border-white/10 bg-background/40 px-2 py-1 text-right text-sm tabular-nums outline-none"
        />
      ) : (
        <dd className="tabular-nums text-foreground">{value}</dd>
      )}
    </div>
  );
}

function reliabilityLabel(
  estimate: DvfMarketEstimate | null,
  sale: AuctionSale,
  useManualMarket: boolean,
): string {
  if (useManualMarket) return "provisoire";
  if (!estimate) return "à compléter";
  const docs = sale.documents_rich?.length ?? 0;
  if (estimate.qualityLabel === "forte" && docs > 0) return "forte";
  if (estimate.qualityLabel === "fragile") return "fragile";
  return "correcte";
}

function buildSuccessConditions(
  sale: AuctionSale,
  result: MarketCeilingResult,
  estimate: DvfMarketEstimate | null,
  useManualMarket: boolean,
): Array<{ icon: ReactNode; title: string; text: string }> {
  const docs = sale.documents_rich ?? [];
  const risks = [...(sale.risks ?? [])].sort((a, b) => (b.severity ?? 0) - (a.severity ?? 0));
  const conditions: Array<{ icon: ReactNode; title: string; text: string }> = [
    {
      icon: <TrendingDown className="h-4 w-4" />,
      title: "Acheter sous le marché",
      text: result.available
        ? `Le scénario sélectionné vise un coût complet de ${ppm2(result.maxAllInPricePerM2)}, soit ${result.safetyDiscountPct}% sous la référence locale.`
        : "Le plafond deviendra exploitable dès qu'un prix de marché local sera renseigné.",
    },
    {
      icon: <FileSearch className="h-4 w-4" />,
      title: "Pièces à relire",
      text:
        docs.length > 0
          ? `${docs.length} pièce${docs.length > 1 ? "s" : ""} disponible${docs.length > 1 ? "s" : ""}. Les points importants doivent rester reliés à leur source.`
          : "Aucune pièce riche n'est encore disponible : le plafond doit rester une hypothèse prudente.",
    },
    {
      icon: <Home className="h-4 w-4" />,
      title: "Occupation",
      text: occupationCondition(sale.occupancy_status),
    },
    {
      icon: <MapPin className="h-4 w-4" />,
      title: "Marché local",
      text:
        estimate && !useManualMarket
          ? `Référence DVF ${estimate.qualityLabel} : ${estimate.sampleSize} ventes comparables retenues dans un rayon de ${estimate.radiusM} m.`
          : "Référence à compléter manuellement si les ventes DVF ne suffisent pas autour de l'adresse.",
    },
  ];

  for (const risk of risks.slice(0, 2)) {
    conditions.push(riskCondition(risk));
  }

  return conditions.slice(0, 6);
}

function occupationCondition(status: string | null | undefined): string {
  const label = occupancyLabel(status);
  const normalized = (status ?? "").toLowerCase();
  if (!status || normalized === "unknown" || normalized === "inconnu") {
    return "Statut à confirmer : le délai de libération doit être intégré avant de fixer la mise finale.";
  }
  if (normalized.includes("occup") || normalized.includes("lou") || normalized.includes("rent")) {
    return `${label} : l'intérêt du dossier dépend du bail, du loyer, du délai et du coût de sortie.`;
  }
  return `${label} : hypothèse favorable, à confirmer dans le PV descriptif ou les conditions de vente.`;
}

function riskCondition(risk: SaleRisk): { icon: ReactNode; title: string; text: string } {
  const label = risk.risk_label || risk.risk_type || "Point à intégrer";
  const normalized = label.toLowerCase();
  const proof = riskProof(risk);
  if (normalized.includes("travaux") || normalized.includes("renov")) {
    return {
      icon: <Wrench className="h-4 w-4" />,
      title: "Travaux à provisionner",
      text: `Le sujet doit être converti en budget travaux avant enchère${proof}.`,
    };
  }
  if (/plomb|amiante|dpe|termite|diagnostic/.test(normalized)) {
    return {
      icon: <ShieldCheck className="h-4 w-4" />,
      title: "Diagnostic à intégrer",
      text: `Le diagnostic ne bloque pas mécaniquement le projet : il sert à calibrer le coût, le délai et la négociation${proof}.`,
    };
  }
  if (normalized.includes("servitude")) {
    return {
      icon: <FileSearch className="h-4 w-4" />,
      title: "Usage à vérifier",
      text: `La servitude doit être traduite en impact concret sur l'usage ou la revente${proof}.`,
    };
  }
  if (normalized.includes("copro")) {
    return {
      icon: <Home className="h-4 w-4" />,
      title: "Copropriété à relire",
      text: `Charges, travaux votés et règlement doivent être intégrés au plafond${proof}.`,
    };
  }
  return {
    icon: <FileSearch className="h-4 w-4" />,
    title: label,
    text: `Point à traduire en hypothèse de prix avant de monter l'enchère${proof}.`,
  };
}

function riskProof(risk: SaleRisk): string {
  const occurrence = risk.occurrences?.[0];
  if (occurrence?.document_type) {
    return `, source : ${documentTypeLabel(occurrence.document_type)}`;
  }
  if (risk.evidence) return ", preuve disponible plus bas";
  return "";
}
