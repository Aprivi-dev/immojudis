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

function scenarioTone(key: MarketCeilingScenarioKey, active: boolean): string {
  if (active)
    return "border-gold/60 bg-gold text-background shadow-[0_18px_50px_rgba(214,160,23,0.22)]";
  if (key === "prudent") return "border-emerald-300/20 bg-emerald-400/10 text-emerald-50";
  if (key === "offensif") return "border-sky-300/20 bg-sky-400/10 text-sky-50";
  return "border-white/10 bg-white/[0.045] text-foreground";
}

export function BidCeilingAssistant({ sale }: { sale: AuctionSale }) {
  const surface =
    sale.app_surface_m2 ?? sale.habitable_surface_m2 ?? sale.carrez_surface_m2 ?? null;
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
          radiusM: 500,
          yearsBack: 2,
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

        <div className="mt-6 grid gap-4 lg:grid-cols-[1fr_260px]">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.22em] text-gold">
              <Target className="h-4 w-4" />
              Mise plafond
            </div>
            <h3 className="mt-3 font-display text-2xl leading-tight text-foreground sm:text-3xl">
              Jusqu'où enchérir en restant sous le marché local ?
            </h3>
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
              Immojudis part du prix au m² observé autour du bien, applique une marge de sécurité,
              puis retire les frais et les travaux. Le résultat est la limite à ne pas dépasser.
            </p>
          </div>

          <div className="rounded-lg border border-gold/30 bg-gold/10 p-4 text-right">
            <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-gold-soft">
              Fourchette utile
            </div>
            <div className="mt-2 text-3xl font-semibold tabular-nums text-foreground">
              {rangeLabel}
            </div>
            <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Prudent à offensif, frais et travaux inclus dans le raisonnement.
            </div>
          </div>
        </div>

        <div className="mt-5 grid gap-3 lg:grid-cols-3">
          {scenarioResults.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setState((current) => ({ ...current, scenario: item.key }))}
              className={`rounded-lg border p-4 text-left transition ${scenarioTone(
                item.key,
                item.key === state.scenario,
              )}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-[0.2em] opacity-75">
                    Scénario
                  </div>
                  <div className="mt-1 text-lg font-semibold">{item.label}</div>
                </div>
                <span className="rounded-full border border-current/20 px-2 py-1 text-[11px] font-medium">
                  -{item.result.safetyDiscountPct}%
                </span>
              </div>
              <div className="mt-4 text-2xl font-semibold tabular-nums">
                {item.result.available ? fmt(item.result.maxBid) : "À compléter"}
              </div>
              <p className="mt-2 text-xs leading-relaxed opacity-80">
                {scenarioCopy(item.key, item.result)}
              </p>
            </button>
          ))}
        </div>

        <div className="mt-5 grid gap-3 lg:grid-cols-[1.1fr_0.9fr]">
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

          <div className="rounded-lg border border-white/10 bg-white/[0.04] p-4">
            <div className="text-xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">
              Lecture simple
            </div>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              En mode <strong className="text-foreground">{selected.label.toLowerCase()}</strong>,
              le plafond ressort à{" "}
              <strong className="text-foreground">
                {selected.result.available ? fmt(selected.result.maxBid) : "compléter"}
              </strong>
              . Au-dessus, le coût complet se rapproche trop du marché local pour garder une marge
              rationnelle.
            </p>
            <div className="mt-3 flex flex-wrap gap-2 text-[11px] font-medium uppercase tracking-[0.12em]">
              <span className="rounded-full border border-white/10 bg-white/[0.05] px-2.5 py-1 text-muted-foreground">
                Surface {formatSurface(surface)}
              </span>
              <span className="rounded-full border border-white/10 bg-white/[0.05] px-2.5 py-1 text-muted-foreground">
                Fiabilité {reliability}
              </span>
            </div>
          </div>
        </div>

        <HypothesisEditor state={state} startingPrice={startingPrice} onChange={setState} />

        <div className="mt-5 grid gap-3 lg:grid-cols-[0.9fr_1.1fr]">
          <SimulationCard result={selected.result} selectedMargin={selectedMargin} />
          <MethodCard result={balanced.result} estimate={effectiveEstimate} />
        </div>

        <SuccessConditions
          sale={sale}
          result={selected.result}
          estimate={effectiveEstimate}
          useManualMarket={useManualMarket}
        />

        <button
          type="button"
          onClick={() => setDetailsOpen((current) => !current)}
          className="mt-5 inline-flex items-center gap-2 text-sm font-medium text-gold-soft transition-colors hover:text-gold"
        >
          <FileSearch className="h-4 w-4" />
          {detailsOpen ? "Masquer le détail" : "Voir le détail des frais et des comparables"}
        </button>

        {detailsOpen && (
          <div className="mt-4 grid gap-4 lg:grid-cols-[0.8fr_1.2fr]">
            <FeesBreakdown result={selected.result} fpt={state.fpt} onChange={setState} />
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

function scenarioCopy(key: MarketCeilingScenarioKey, result: MarketCeilingResult): string {
  if (!result.available) return "À utiliser dès que le prix local est renseigné.";
  if (key === "prudent") {
    return `Position confortable : coût tout compris cible ${ppm2(result.maxAllInPricePerM2)}.`;
  }
  if (key === "offensif") {
    return `Pour un dossier très lisible : coût cible ${ppm2(result.maxAllInPricePerM2)}.`;
  }
  return `Seuil recommandé : coût tout compris cible ${ppm2(result.maxAllInPricePerM2)}.`;
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
