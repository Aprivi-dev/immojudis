import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { TrendingDown, TrendingUp, Minus, MapPin, Info } from "lucide-react";
import { getMarketEstimate } from "@/lib/market.functions";
import { formatPrice, formatDate } from "@/lib/format";
import type { AuctionSale } from "@/lib/types";

function verdictTone(deviation: number | null): { label: string; tone: "good" | "ok" | "warn" | "bad" } {
  if (deviation == null) return { label: "—", tone: "ok" };
  if (deviation <= -20) return { label: "Très inférieur au marché", tone: "good" };
  if (deviation <= -5) return { label: "Inférieur au marché", tone: "good" };
  if (deviation < 5) return { label: "Aligné avec le marché", tone: "ok" };
  if (deviation < 15) return { label: "Légèrement au-dessus", tone: "warn" };
  return { label: "Au-dessus du marché", tone: "bad" };
}

const TONE_CLASSES: Record<"good" | "ok" | "warn" | "bad", string> = {
  good: "bg-emerald-50 text-emerald-900 border-emerald-200 dark:bg-emerald-900/20 dark:text-emerald-200 dark:border-emerald-900/40",
  ok: "bg-blue-50 text-blue-900 border-blue-200 dark:bg-blue-900/20 dark:text-blue-200 dark:border-blue-900/40",
  warn: "bg-amber-50 text-amber-900 border-amber-200 dark:bg-amber-900/20 dark:text-amber-200 dark:border-amber-900/40",
  bad: "bg-red-50 text-red-900 border-red-200 dark:bg-red-900/20 dark:text-red-200 dark:border-red-900/40",
};

type Props = {
  sale: AuctionSale;
  /** Prix actuel à comparer (peut être adjudication courante du calculateur, sinon mise à prix) */
  currentPrice?: number;
  /** Surface utilisée pour le calcul */
  surface?: number | null;
};

export function MarketEstimate({ sale, currentPrice, surface }: Props) {
  const lat = sale.latitude;
  const lng = sale.longitude;
  const refSurface = surface ?? sale.app_surface_m2 ?? sale.habitable_surface_m2 ?? null;
  const refPrice = currentPrice ?? sale.starting_price_eur ?? 0;
  const pricePerM2Ref = refSurface && refSurface > 0 && refPrice > 0 ? refPrice / refSurface : null;

  const fetchEstimate = useServerFn(getMarketEstimate);

  const { data, isLoading, error } = useQuery({
    queryKey: ["market-estimate", sale.id, lat, lng, sale.property_type],
    queryFn: () =>
      fetchEstimate({
        data: {
          lat: lat!,
          lng: lng!,
          radiusM: 500,
          yearsBack: 2,
          propertyType: sale.property_type,
        },
      }),
    enabled: lat != null && lng != null,
    staleTime: 24 * 60 * 60_000,
  });

  const verdict = useMemo(() => {
    if (!data?.estimate?.medianPricePerM2 || pricePerM2Ref == null) return null;
    const dev = ((pricePerM2Ref - data.estimate.medianPricePerM2) / data.estimate.medianPricePerM2) * 100;
    return { ...verdictTone(dev), deviation: dev };
  }, [data, pricePerM2Ref]);

  if (lat == null || lng == null) {
    return (
      <div className="rounded-md border border-border bg-background p-3 text-sm text-muted-foreground">
        Estimation marché indisponible : coordonnées GPS manquantes.
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="rounded-md border border-border bg-background p-3 text-sm text-muted-foreground">
        Chargement des transactions DVF du quartier…
      </div>
    );
  }

  if (error || !data?.ok) {
    return (
      <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/40 dark:bg-amber-900/20 dark:text-amber-200">
        {data?.error ?? "Impossible de charger l'estimation de marché."}
      </div>
    );
  }

  const est = data.estimate;
  if (!est) return null;

  if (est.sampleSize < 3 || est.medianPricePerM2 == null) {
    return (
      <div className="rounded-md border border-border bg-background p-3 text-sm text-muted-foreground">
        Pas assez de transactions DVF comparables dans un rayon de 500&nbsp;m ({est.sampleSize} trouvée{est.sampleSize > 1 ? "s" : ""}).
      </div>
    );
  }

  const Icon = verdict == null ? Minus : verdict.deviation < 0 ? TrendingDown : verdict.deviation > 0 ? TrendingUp : Minus;

  return (
    <div className={`rounded-md border p-4 ${verdict ? TONE_CLASSES[verdict.tone] : "border-border bg-background"}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide opacity-80">
            <MapPin className="h-3.5 w-3.5" /> Prix de marché (DVF)
          </div>
          <div className="mt-1 text-2xl font-bold tabular-nums">
            {formatPrice(est.medianPricePerM2!)} <span className="text-sm font-normal opacity-80">/m²</span>
          </div>
          <div className="mt-0.5 text-xs opacity-80">
            Médiane sur {est.sampleSize} ventes · rayon {est.radiusM} m · {est.yearsBack} ans
          </div>
          {est.p25PricePerM2 != null && est.p75PricePerM2 != null && (
            <div className="mt-1 text-xs opacity-70">
              Fourchette {formatPrice(est.p25PricePerM2)} – {formatPrice(est.p75PricePerM2)} €/m²
            </div>
          )}
        </div>
        {verdict && (
          <div className="text-right">
            <div className="flex items-center justify-end gap-1 text-sm font-semibold">
              <Icon className="h-4 w-4" />
              {verdict.deviation >= 0 ? "+" : ""}
              {verdict.deviation.toFixed(1)}%
            </div>
            <div className="mt-0.5 text-xs">{verdict.label}</div>
            {pricePerM2Ref != null && (
              <div className="mt-1 text-xs opacity-80">
                Bien : {formatPrice(Math.round(pricePerM2Ref))} €/m²
              </div>
            )}
          </div>
        )}
      </div>

      {est.recentTransactions.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs font-medium opacity-80 hover:opacity-100">
            Voir les {est.recentTransactions.length} dernières transactions comparables
          </summary>
          <ul className="mt-2 divide-y divide-current/10 text-xs">
            {est.recentTransactions.map((t, i) => (
              <li key={i} className="flex items-center justify-between gap-3 py-1.5">
                <span className="opacity-80">{formatDate(t.date)}</span>
                <span className="opacity-70">{t.surface.toFixed(0)} m²</span>
                <span className="font-medium tabular-nums">{formatPrice(t.totalPrice)}</span>
                <span className="font-semibold tabular-nums">
                  {formatPrice(Math.round(t.pricePerM2))} €/m²
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <p className="mt-3 flex items-start gap-1.5 text-[11px] opacity-70">
        <Info className="mt-0.5 h-3 w-3 shrink-0" />
        Source : Demandes de Valeurs Foncières (DGFiP) via Cerema. Ventes réelles enregistrées, hors VEFA et donations.
      </p>
    </div>
  );
}