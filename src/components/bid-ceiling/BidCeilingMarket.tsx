import MapPin from "lucide-react/dist/esm/icons/map-pin.js";
import type { MarketEstimate as DvfMarketEstimate } from "@/lib/market.server";
import { formatDate, formatPrice, formatSurface } from "@/lib/format";
import { fmt, ppm2 } from "@/components/bid-ceiling/assistant-state";

export function MarketInput({
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
    ? "Le marché local manque de comparables solides. Saisissez un prix au m² réaliste pour obtenir un plafond provisoire."
    : marketEdited
      ? `Prix saisi utilisé à la place de la médiane DVF (${ppm2(automaticPrice)}). Effacez le champ pour revenir au calcul automatique.`
      : usingCachedEstimate
        ? `Dernière estimation DVF conservée : médiane ${ppm2(automaticPrice)}.`
        : `Calcul automatique actif : médiane DVF ${ppm2(automaticPrice)}.`;

  return (
    <div
      className={`rounded-lg border p-4 ${
        needsManual ? "border-amber-300/40 bg-amber-50" : "border-border bg-muted/35"
      }`}
    >
      <div className="grid gap-3 sm:grid-cols-[1fr_180px] sm:items-end">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-gold-text">
            <MapPin className="h-4 w-4" />
            Prix de marché local
          </div>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {isLoading ? "Chargement de l'estimation pré-calculée..." : helper}
          </p>
        </div>
        <label className="block">
          <span className="text-xs font-medium text-muted-foreground">Saisie manuelle</span>
          <div className="mt-1 flex items-center rounded-md border border-border bg-white focus-within:ring-1 focus-within:ring-ring">
            <input
              type="number"
              inputMode="decimal"
              min={0}
              step={50}
              value={value > 0 ? value : ""}
              placeholder={automaticPrice ? String(Math.round(automaticPrice)) : "ex. 3 200"}
              onChange={(event) => onChange(parseFloat(event.target.value) || 0)}
              className="w-full bg-transparent px-3 py-2 text-sm tabular-nums outline-none placeholder:text-muted-foreground"
            />
            <span className="pr-3 text-xs text-muted-foreground">€/m²</span>
          </div>
        </label>
      </div>
    </div>
  );
}

/**
 * Price-per-m² spread of the comparables and the address history, shown with
 * the market references (they were previously only inside the bid assistant).
 */
export function MarketPriceDistribution({ estimate }: { estimate: DvfMarketEstimate }) {
  const hasRange = Boolean(estimate.medianPricePerM2 || estimate.medianUnitPriceEur);
  return (
    <div className="mt-7 rounded-lg border border-slate-200 bg-white p-5 sm:p-6">
      {hasRange ? <PriceRange estimate={estimate} /> : null}
      {estimate.comparableMode !== "address_history" ? (
        <AddressHistory estimate={estimate} />
      ) : null}
    </div>
  );
}

function PriceRange({ estimate }: { estimate: DvfMarketEstimate }) {
  if (estimate.surfaceBasis === "unit" && estimate.medianUnitPriceEur) {
    return (
      <div className="mt-4 flex items-baseline justify-between border-y border-border py-3 text-xs">
        <span className="uppercase tracking-[0.12em] text-muted-foreground">
          Prix unitaire observé
        </span>
        <span className="tabular-nums text-foreground">
          {estimate.p10UnitPriceEur ? formatPrice(estimate.p10UnitPriceEur) : "—"} à{" "}
          {estimate.p90UnitPriceEur ? formatPrice(estimate.p90UnitPriceEur) : "—"}
          {" · médiane "}
          <strong>{formatPrice(estimate.medianUnitPriceEur)}</strong>
        </span>
      </div>
    );
  }
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
        <span>
          {estimate.surfaceBasis === "land" ? "Prix foncier au m² observé" : "Prix au m² observé"}
        </span>
        <span className="tabular-nums">
          médiane <strong className="text-foreground">{ppm2(median)}</strong>
        </span>
      </div>
      <div className="relative mt-5 h-2 rounded-full bg-muted">
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
          la moitié des ventes entre {ppm2(p25)} et {ppm2(p75)}
        </span>
        <span>max {ppm2(max)}</span>
      </div>
    </div>
  );
}

function AddressHistory({ estimate }: { estimate: DvfMarketEstimate | null }) {
  const history = estimate?.addressHistory ?? [];
  return (
    <div className="mt-4 border-t border-border pt-4">
      <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        Historique de l'adresse
      </div>
      {history.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">
          Aucune vente connue à cette adresse dans les données DVF récentes.
        </p>
      ) : (
        <ul className="mt-2 divide-y divide-border text-sm">
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

export function ComparableTransactions({ estimate }: { estimate: DvfMarketEstimate | null }) {
  if (!estimate || estimate.recentTransactions.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-muted/35 p-4 text-sm text-muted-foreground">
        Aucune transaction comparable détaillée à afficher pour le moment.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-muted/35 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Transactions DVF utilisées
        </div>
        <div className="text-xs text-muted-foreground">
          {estimate.sampleSize} ventes, rayon {estimate.radiusM} m
        </div>
      </div>
      <ul className="mt-3 divide-y divide-border text-xs">
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
