import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import AlertTriangle from "lucide-react/dist/esm/icons/alert-triangle.js";
import Calculator from "lucide-react/dist/esm/icons/calculator.js";
import CheckCircle2 from "lucide-react/dist/esm/icons/check-circle-2.js";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.js";
import ChevronUp from "lucide-react/dist/esm/icons/chevron-up.js";
import Info from "lucide-react/dist/esm/icons/info.js";
import MapPin from "lucide-react/dist/esm/icons/map-pin.js";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import Target from "lucide-react/dist/esm/icons/target.js";
import TrendingDown from "lucide-react/dist/esm/icons/trending-down.js";
import {
  computeMarketCeiling,
  DEFAULTS,
  MARKET_CEILING_SCENARIOS,
  marketCeilingVerdict,
  type MarketCeilingResult,
  type MarketCeilingScenarioKey,
} from "@/lib/profitability";
import {
  getMarketEstimate,
  type MarketEstimate as DvfMarketEstimate,
} from "@/lib/market.functions";
import { formatDate, formatPrice, formatPricePerM2 } from "@/lib/format";
import type { AuctionSale } from "@/lib/types";

type StoredState = {
  price: number;
  works: number;
  fpt: number;
  scenario: MarketCeilingScenarioKey | "custom";
  customSafetyDiscountPct: number;
  manualMarketPricePerM2: number;
  marketEdited: boolean;
};

const MARKET_ESTIMATE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type CachedMarketEstimatePayload = {
  savedAt: number;
  estimate: DvfMarketEstimate;
};

function storageKey(saleId: string) {
  return `market-ceiling:${saleId}`;
}

function marketEstimateCacheKey(saleId: string) {
  return `market-estimate:${saleId}`;
}

function loadState(saleId: string): Partial<StoredState> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(storageKey(saleId));
    if (!raw) return null;
    return JSON.parse(raw) as Partial<StoredState>;
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

function ppm2(value: number): string {
  return formatPricePerM2(value);
}

function signedMoney(value: number): string {
  const rounded = Math.round(value || 0);
  if (rounded === 0) return "0 €";
  return `${rounded > 0 ? "+" : "-"}${fmt(Math.abs(rounded))}`;
}

function signedPpm2(value: number): string {
  const rounded = Math.round(value || 0);
  if (rounded === 0) return formatPricePerM2(0);
  return `${rounded > 0 ? "+" : "-"}${formatPricePerM2(Math.abs(rounded))}`;
}

export function ProfitabilityCalculator({ sale }: { sale: AuctionSale }) {
  const surface =
    sale.app_surface_m2 ?? sale.habitable_surface_m2 ?? sale.carrez_surface_m2 ?? null;
  const startingPrice = sale.starting_price_eur ?? 0;
  const lat = sale.latitude;
  const lng = sale.longitude;
  const fetchEstimate = useServerFn(getMarketEstimate);

  const [expert, setExpert] = useState(false);
  const [cachedEstimate, setCachedEstimate] = useState<DvfMarketEstimate | null>(() =>
    loadCachedMarketEstimate(sale.id),
  );
  const [state, setState] = useState<StoredState>(() => ({
    price: startingPrice,
    works: 0,
    fpt: DEFAULTS.fpt,
    scenario: "equilibre",
    customSafetyDiscountPct: DEFAULTS.safetyDiscountPct,
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
    queryKey: ["market-estimate", sale.id, lat, lng, sale.property_type, Math.round(surface ?? 0)],
    queryFn: () =>
      fetchEstimate({
        data: {
          lat: lat!,
          lng: lng!,
          radiusM: 500,
          yearsBack: 2,
          propertyType: sale.property_type,
          surfaceM2: surface,
        },
      }),
    enabled: lat != null && lng != null && surface != null && surface > 0,
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
  const result = useMemo(
    () =>
      computeMarketCeiling({
        surface,
        price: state.price,
        works: state.works,
        fpt: state.fpt,
        scenario: state.scenario,
        customSafetyDiscountPct: state.customSafetyDiscountPct,
        manualMarketPricePerM2: useManualMarket ? state.manualMarketPricePerM2 : null,
        medianPricePerM2: effectiveEstimate?.medianPricePerM2,
        p25PricePerM2: effectiveEstimate?.p25PricePerM2,
        p75PricePerM2: effectiveEstimate?.p75PricePerM2,
      }),
    [effectiveEstimate, state, surface, useManualMarket],
  );

  const verdict = marketCeilingVerdict(result);
  const verdictTone: Record<typeof verdict.tone, string> = {
    good: "border-emerald-300/20 bg-emerald-400/10 text-emerald-100",
    ok: "border-sky-300/20 bg-sky-400/10 text-sky-100",
    warn: "border-amber-300/20 bg-amber-400/10 text-amber-100",
    bad: "border-red-300/20 bg-red-500/10 text-red-100",
  };

  const reset = () => {
    if (typeof window !== "undefined") window.localStorage.removeItem(storageKey(sale.id));
    setState({
      price: startingPrice,
      works: 0,
      fpt: DEFAULTS.fpt,
      scenario: "equilibre",
      customSafetyDiscountPct: DEFAULTS.safetyDiscountPct,
      manualMarketPricePerM2: 0,
      marketEdited: false,
    });
  };

  if (!surface || surface <= 0) {
    return (
      <section className="liquid-panel rounded-lg p-5">
        <Header />
        <p className="mt-3 text-sm text-muted-foreground">
          Calcul indisponible : la surface du bien n'est pas renseignée.
        </p>
      </section>
    );
  }

  return (
    <section className="liquid-panel rounded-lg p-5">
      <Header onReset={reset} />

      <MarketCeilingPanel
        result={result}
        estimate={effectiveEstimate}
        isLoading={isLoading && !effectiveEstimate}
        hasError={hasDvfError && !effectiveEstimate}
        usingCachedEstimate={usingCachedEstimate}
        scenario={state.scenario}
        customSafetyDiscountPct={state.customSafetyDiscountPct}
        manualMarketPricePerM2={state.manualMarketPricePerM2}
        marketEdited={state.marketEdited}
        onScenarioChange={(scenario) =>
          setState((current) => ({
            ...current,
            scenario,
            customSafetyDiscountPct:
              MARKET_CEILING_SCENARIOS.find((item) => item.key === scenario)?.safetyDiscountPct ??
              current.customSafetyDiscountPct,
          }))
        }
        onCustomSafetyChange={(customSafetyDiscountPct) =>
          setState((current) => ({
            ...current,
            scenario: "custom",
            customSafetyDiscountPct: Math.max(0, customSafetyDiscountPct),
          }))
        }
        onManualMarketChange={(manualMarketPricePerM2) =>
          setState((current) => ({
            ...current,
            manualMarketPricePerM2,
            marketEdited: manualMarketPricePerM2 > 0,
          }))
        }
      />

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field
          label="Prix d'adjudication simulé"
          suffix="€"
          value={state.price}
          onChange={(value) => setState((current) => ({ ...current, price: value }))}
          hint={`Mise à prix : ${formatPrice(startingPrice)}`}
        />
        <Field
          label="Travaux estimés"
          suffix="€"
          value={state.works}
          onChange={(value) => setState((current) => ({ ...current, works: value }))}
          hint="Montant à absorber dans le seuil"
        />
      </div>

      <div className={`mt-4 rounded-lg border p-4 ${verdictTone[verdict.tone]}`}>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide opacity-80">
              Lecture du prix simulé
            </div>
            <div className="mt-1 text-3xl font-bold tabular-nums">
              {ppm2(result.simulatedAllInPricePerM2)}
            </div>
            <div className="mt-1 text-sm font-medium">{verdict.label}</div>
            <div className="mt-0.5 text-xs opacity-85">{verdict.detail}</div>
          </div>
          <div className="text-right">
            <div className="text-xs uppercase tracking-wide opacity-80">Coût de revient simulé</div>
            <div className="mt-1 text-xl font-semibold tabular-nums">
              {fmt(result.simulated.totalCost)}
            </div>
            <div className="mt-0.5 text-xs opacity-80">
              Enchère + frais + travaux, soit {ppm2(result.simulatedAllInPricePerM2)}
            </div>
          </div>
        </div>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
        <Cell label="Enchère simulée / m²" value={ppm2(result.simulatedBidPricePerM2)} />
        <Cell
          label="Frais estimés"
          value={`${fmt(result.simulated.acquisitionFeesTotal)} (${result.simulated.acquisitionFeesPct.toFixed(1)} %)`}
        />
        <Cell label="Travaux absorbables" value={fmt(result.maxWorksAtSimulatedPrice)} />
        <Cell
          label="Marge totale"
          value={result.available ? signedMoney(result.marginTotal) : "À compléter"}
        />
      </dl>

      <div className="mt-4 rounded-lg border border-white/10 bg-background/25 p-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Coût complet retenu
        </div>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          Pour une enchère simulée à <strong className="text-foreground">{fmt(state.price)}</strong>
          , Immojudis ajoute{" "}
          <strong className="text-foreground">{fmt(result.simulated.acquisitionFeesTotal)}</strong>{" "}
          de frais d'adjudication estimés et{" "}
          <strong className="text-foreground">{fmt(state.works)}</strong> de travaux. Le coût
          comparé au marché local est donc{" "}
          <strong className="text-foreground">{fmt(result.simulated.totalCost)}</strong>.
        </p>
      </div>

      <button
        type="button"
        onClick={() => setExpert((current) => !current)}
        className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
      >
        {expert ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        {expert ? "Masquer le détail" : "Voir le détail des frais et des comparables"}
      </button>

      {expert && (
        <div className="mt-3 space-y-4">
          <div className="liquid-panel-soft rounded-lg p-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Détail des frais d'adjudication
            </div>
            <dl className="mt-2 grid grid-cols-1 gap-1 text-sm sm:grid-cols-2">
              <Row label="Émoluments avocat (HT)" value={fmt(result.simulated.emolumentsHT)} />
              <Row
                label="TVA sur émoluments"
                value={fmt(result.simulated.emolumentsTTC - result.simulated.emolumentsHT)}
              />
              <Row
                label="Droits d'enregistrement (5,80 %)"
                value={fmt(result.simulated.registrationDuties)}
              />
              <Row
                label="Frais préalables taxés (FPT)"
                value={fmt(result.simulated.fpt)}
                editable
                current={state.fpt}
                onEdit={(value) => setState((current) => ({ ...current, fpt: value }))}
              />
              <Row label="Travaux" value={fmt(result.simulated.works)} />
              <Row
                label="Total des frais hors travaux"
                value={fmt(result.simulated.acquisitionFeesTotal)}
                bold
              />
            </dl>
          </div>

          <ComparableTransactions estimate={effectiveEstimate} />
        </div>
      )}

      <p className="mt-4 flex items-start gap-1.5 text-xs text-muted-foreground">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        Le seuil compare un coût de revient complet aux ventes DVF proches : enchère, frais
        d'adjudication et travaux sont donc tous intégrés. Ce calcul ne remplace pas l'avis d'un
        avocat ou d'un professionnel local.
      </p>
    </section>
  );
}

function MarketCeilingPanel({
  result,
  estimate,
  isLoading,
  hasError,
  usingCachedEstimate,
  scenario,
  customSafetyDiscountPct,
  manualMarketPricePerM2,
  marketEdited,
  onScenarioChange,
  onCustomSafetyChange,
  onManualMarketChange,
}: {
  result: MarketCeilingResult;
  estimate: DvfMarketEstimate | null;
  isLoading: boolean;
  hasError: boolean;
  usingCachedEstimate: boolean;
  scenario: MarketCeilingScenarioKey | "custom";
  customSafetyDiscountPct: number;
  manualMarketPricePerM2: number;
  marketEdited: boolean;
  onScenarioChange: (scenario: MarketCeilingScenarioKey) => void;
  onCustomSafetyChange: (value: number) => void;
  onManualMarketChange: (value: number) => void;
}) {
  const hasAutomaticMarket = Boolean(estimate?.medianPricePerM2);

  return (
    <div className="mt-4 overflow-hidden rounded-lg border border-gold/25 bg-gold/10">
      <div className="grid gap-4 p-4 lg:grid-cols-[1fr_auto]">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gold-soft">
            <Target className="h-4 w-4" />
            Prix max au m²
          </div>
          <h3 className="mt-2 text-xl font-semibold text-foreground">
            À quel prix acheter sans dépasser le marché local ?
          </h3>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            On part des ventes DVF proches, on applique une marge de sécurité, puis on retire les
            frais et les travaux pour obtenir l'enchère maximale.
          </p>
        </div>

        <div className="rounded-lg border border-white/10 bg-background/35 px-4 py-3 text-right">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Coût max tout compris
          </div>
          <div className="mt-1 text-3xl font-bold tabular-nums text-foreground">
            {result.available ? ppm2(result.maxAllInPricePerM2) : "À compléter"}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {result.available ? `enchère max ${fmt(result.maxBid)}` : result.reason}
          </div>
        </div>
      </div>

      <div className="border-t border-white/10 px-4 py-3">
        <ManualMarketInput
          estimate={estimate}
          value={manualMarketPricePerM2}
          marketEdited={marketEdited}
          usingCachedEstimate={usingCachedEstimate}
          hasError={hasError}
          isLoading={isLoading}
          onChange={onManualMarketChange}
        />

        <div className="grid gap-3 lg:grid-cols-[1fr_160px]">
          <div className="grid grid-cols-3 gap-1 rounded-md border border-white/10 bg-black/10 p-1">
            {MARKET_CEILING_SCENARIOS.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => onScenarioChange(item.key)}
                className={`rounded px-2 py-2 text-left text-xs transition-colors ${
                  scenario === item.key
                    ? "bg-gold text-background"
                    : "text-muted-foreground hover:bg-white/10 hover:text-foreground"
                }`}
                title={item.description}
              >
                <span className="block font-semibold">{item.label}</span>
                <span className="block opacity-80">
                  {hasAutomaticMarket ? item.basisLabel : "marge"} -{item.safetyDiscountPct}%
                </span>
              </button>
            ))}
          </div>

          <label className="block">
            <span className="text-xs font-medium text-muted-foreground">Marge de sécurité</span>
            <div
              className={`mt-1 flex items-center rounded-md border bg-black/10 focus-within:ring-1 focus-within:ring-ring ${
                scenario === "custom" ? "border-gold/50" : "border-white/10"
              }`}
            >
              <input
                type="number"
                inputMode="decimal"
                min={0}
                max={40}
                step={1}
                value={
                  Number.isFinite(result.safetyDiscountPct)
                    ? result.safetyDiscountPct
                    : customSafetyDiscountPct
                }
                onChange={(event) => onCustomSafetyChange(parseFloat(event.target.value) || 0)}
                className="w-full bg-transparent px-3 py-2 text-sm tabular-nums outline-none"
              />
              <span className="pr-3 text-xs text-muted-foreground">%</span>
            </div>
          </label>
        </div>

        <MarketProof
          result={result}
          estimate={estimate}
          isLoading={isLoading}
          hasError={hasError}
          usingCachedEstimate={usingCachedEstimate}
        />

        <div className="mt-3 grid gap-2 md:grid-cols-4">
          <FormulaStep
            index="1"
            title="Prix local"
            detail={
              result.available
                ? `${result.basisLabel} retenue : ${ppm2(result.marketReferencePricePerM2)}.`
                : "On attend une référence DVF ou un prix marché manuel."
            }
          />
          <FormulaStep
            index="2"
            title="Sécurité"
            detail={
              result.available
                ? `Marge déduite : -${result.safetyDiscountPct}% (${ppm2(result.safetyDiscountPerM2)}).`
                : "La marge évite d'acheter au même prix qu'une vente classique."
            }
          />
          <FormulaStep
            index="3"
            title="Seuil tout compris"
            detail={
              result.available
                ? `${ppm2(result.maxAllInPricePerM2)} × ${result.surface.toFixed(0)} m² = ${fmt(result.targetTotalCost)}.`
                : "Le seuil inclura enchère, frais et travaux."
            }
          />
          <FormulaStep
            index="4"
            title="Enchère max"
            detail={
              result.available
                ? `Après frais et travaux : ${fmt(result.maxBid)} à ne pas dépasser.`
                : "Impossible tant que le prix marché n'est pas connu."
            }
          />
        </div>

        <div
          className={`mt-3 rounded-md border px-3 py-2 text-sm ${
            result.available && result.maxBidIsReachable
              ? result.marginTotal >= 0
                ? "border-emerald-300/20 bg-emerald-400/10 text-emerald-100"
                : "border-amber-300/20 bg-amber-400/10 text-amber-100"
              : "border-red-300/20 bg-red-500/10 text-red-100"
          }`}
        >
          <div className="flex items-start gap-2">
            {result.available && result.marginTotal >= 0 ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            ) : (
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            )}
            <div>
              <div className="font-semibold">
                {result.available
                  ? result.marginTotal >= 0
                    ? "Le prix simulé reste sous le seuil"
                    : "Le prix simulé dépasse le seuil"
                  : "Référence marché insuffisante"}
              </div>
              <p className="text-xs opacity-85">
                {result.available
                  ? `${signedMoney(result.marginTotal)} de marge totale, soit ${signedPpm2(result.marginPerM2)}.`
                  : "Renseigne le prix au m² estimé du quartier pour obtenir immédiatement un seuil provisoire."}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ManualMarketInput({
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
    ? "Impossible de calculer un plafond fiable automatiquement : il manque assez de ventes comparables autour du bien. Saisis un prix de marché au m² pour obtenir un seuil provisoire."
    : marketEdited
      ? `Prix saisi utilisé à la place de la médiane DVF (${formatPricePerM2(automaticPrice)}). Efface le champ pour revenir au calcul automatique.`
      : usingCachedEstimate
        ? `Dernière estimation DVF conservée : médiane ${formatPricePerM2(automaticPrice)}. Le recalcul automatique sera repris dès que la donnée externe répond correctement.`
        : `Calcul automatique actif : médiane DVF ${formatPricePerM2(automaticPrice)}. Tu peux saisir un autre prix si tu connais mieux le quartier.`;

  return (
    <div
      className={`mb-3 rounded-md border p-3 ${
        needsManual ? "border-amber-300/25 bg-amber-400/10" : "border-white/10 bg-background/25"
      }`}
    >
      <div className="grid gap-3 sm:grid-cols-[1fr_180px] sm:items-end">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-foreground">
            Prix de marché local
          </div>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            {isLoading ? "Recherche des ventes DVF proches en cours…" : helper}
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

function MarketProof({
  result,
  estimate,
  isLoading,
  hasError,
  usingCachedEstimate,
}: {
  result: MarketCeilingResult;
  estimate: DvfMarketEstimate | null;
  isLoading: boolean;
  hasError: boolean;
  usingCachedEstimate: boolean;
}) {
  if (isLoading) {
    return (
      <div className="mt-3 rounded-md border border-white/10 bg-black/10 p-3 text-sm text-muted-foreground">
        Chargement des ventes DVF proches…
      </div>
    );
  }

  if (hasError) {
    return (
      <div className="mt-3 rounded-md border border-amber-300/20 bg-amber-400/10 p-3 text-sm text-amber-100">
        Données DVF temporairement indisponibles. Le calcul peut fonctionner avec un prix marché
        manuel.
      </div>
    );
  }

  if (!estimate || !estimate.medianPricePerM2) {
    return (
      <div className="mt-3 rounded-md border border-amber-300/20 bg-amber-400/10 p-3 text-sm text-amber-100">
        Pas assez de ventes comparables solides dans le secteur. Le mode manuel ci-dessus permet de
        continuer avec une hypothèse de marché clairement signalée comme provisoire.
      </div>
    );
  }

  return (
    <div className="mt-3 grid gap-2 md:grid-cols-3">
      <CeilingMetric
        icon={<MapPin className="h-4 w-4" />}
        label="Preuve DVF"
        value={`${estimate.sampleSize} ventes`}
        detail={
          estimate.comparableMode === "surface_matched" &&
          estimate.surfaceMinM2 &&
          estimate.surfaceMaxM2
            ? `${estimate.radiusM > 500 ? "Rayon élargi, " : ""}${estimate.radiusM} m, surfaces ${estimate.surfaceMinM2}-${estimate.surfaceMaxM2} m².`
            : `${estimate.radiusM > 500 ? "Rayon élargi, " : ""}${estimate.radiusM} m, même type de bien quand disponible.`
        }
      />
      <CeilingMetric
        icon={<TrendingDown className="h-4 w-4" />}
        label="Fourchette locale"
        value={`${formatPricePerM2(estimate.p25PricePerM2)} - ${formatPricePerM2(estimate.p75PricePerM2)}`}
        detail={`Médiane DVF : ${ppm2(estimate.medianPricePerM2)}. Fiabilité ${estimate.qualityLabel} (${estimate.qualityScore}/100).`}
      />
      <CeilingMetric
        icon={<ShieldCheck className="h-4 w-4" />}
        label="Base retenue"
        value={ppm2(result.marketReferencePricePerM2)}
        detail={`On retire ${result.safetyDiscountPct}% pour frais, risque et négociation.`}
      />
      {estimate.qualityWarnings.length > 0 && (
        <p className="md:col-span-3 rounded-md border border-amber-300/20 bg-amber-400/10 px-3 py-2 text-xs leading-relaxed text-amber-100">
          Prudence sur le marché local : {estimate.qualityWarnings.join(", ")}.
        </p>
      )}
      {usingCachedEstimate && (
        <p className="md:col-span-3 rounded-md border border-sky-300/20 bg-sky-400/10 px-3 py-2 text-xs leading-relaxed text-sky-100">
          Estimation DVF conservée depuis le dernier chargement réussi. Elle évite de perdre le
          calcul lorsque l'API externe répond de façon intermittente.
        </p>
      )}
    </div>
  );
}

function ComparableTransactions({ estimate }: { estimate: DvfMarketEstimate | null }) {
  if (!estimate || estimate.recentTransactions.length === 0) {
    return (
      <div className="liquid-panel-soft rounded-lg p-3 text-sm text-muted-foreground">
        Aucune transaction comparable détaillée à afficher.
      </div>
    );
  }

  return (
    <div className="liquid-panel-soft rounded-lg p-3">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Transactions DVF utilisées
      </div>
      <ul className="mt-2 divide-y divide-current/10 text-xs">
        {estimate.recentTransactions.map((transaction, index) => (
          <li
            key={`${transaction.date}-${transaction.totalPrice}-${index}`}
            className="grid grid-cols-4 gap-2 py-2"
          >
            <span className="text-muted-foreground">{formatDate(transaction.date)}</span>
            <span>{transaction.surface.toFixed(0)} m²</span>
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

function FormulaStep({ index, title, detail }: { index: string; title: string; detail: string }) {
  return (
    <div className="rounded border border-white/10 bg-background/30 p-2.5">
      <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
        <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-gold text-[11px] text-background">
          {index}
        </span>
        {title}
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{detail}</p>
    </div>
  );
}

function CeilingMetric({
  icon,
  label,
  value,
  detail,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-md border border-white/10 bg-white/[0.04] p-3">
      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <span className="text-gold-soft">{icon}</span>
        {label}
      </div>
      <div className="mt-1 text-lg font-semibold tabular-nums text-foreground">{value}</div>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{detail}</p>
    </div>
  );
}

function Header({ onReset }: { onReset?: () => void }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        <Calculator className="h-5 w-5 text-primary" />
        <h2 className="text-lg font-semibold">Calculateur de seuil d'enchère</h2>
      </div>
      {onReset && (
        <button
          type="button"
          onClick={onReset}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          title="Réinitialiser"
        >
          <RotateCcw className="h-3.5 w-3.5" /> Réinitialiser
        </button>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  suffix,
  hint,
  step = 1,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  suffix?: string;
  hint?: string;
  step?: number;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="mt-1 flex items-center rounded-md border border-white/10 bg-white/[0.05] focus-within:ring-1 focus-within:ring-ring">
        <input
          type="number"
          inputMode="decimal"
          step={step}
          value={Number.isFinite(value) ? value : 0}
          onChange={(event) => onChange(parseFloat(event.target.value) || 0)}
          className="w-full bg-transparent px-3 py-1.5 text-sm tabular-nums outline-none"
        />
        {suffix && <span className="pr-3 text-xs text-muted-foreground">{suffix}</span>}
      </div>
      {hint && <span className="mt-1 block text-[11px] text-muted-foreground">{hint}</span>}
    </label>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div className="liquid-panel-soft rounded-lg p-3">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-semibold tabular-nums text-foreground">{value}</dd>
    </div>
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
      className={`flex items-center justify-between gap-3 ${bold ? "border-t border-border pt-1.5 font-semibold" : ""}`}
    >
      <span className="text-muted-foreground">{label}</span>
      {editable && onEdit ? (
        <input
          type="number"
          value={current ?? 0}
          onChange={(event) => onEdit(parseFloat(event.target.value) || 0)}
          className="w-24 rounded border border-input bg-background px-2 py-0.5 text-right text-sm tabular-nums"
        />
      ) : (
        <span className="tabular-nums text-foreground">{value}</span>
      )}
    </div>
  );
}
