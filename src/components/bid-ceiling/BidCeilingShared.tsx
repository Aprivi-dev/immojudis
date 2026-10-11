import type { MarketEstimate as DvfMarketEstimate } from "@/lib/market.server";
import { marketReferenceConfidence } from "@/lib/market-comparables-analysis";

export function Field({
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
      <div className="mt-1 flex items-center rounded-md border border-border bg-white focus-within:ring-1 focus-within:ring-ring">
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

export function Row({
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
        bold ? "border-t border-border pt-2 font-semibold" : ""
      }`}
    >
      <dt className="text-muted-foreground">{label}</dt>
      {editable && onEdit ? (
        <input
          type="number"
          value={current ?? 0}
          onChange={(event) => onEdit(parseFloat(event.target.value) || 0)}
          className="w-24 rounded border border-border bg-white px-2 py-1 text-right text-sm tabular-nums outline-none"
        />
      ) : (
        <dd className="tabular-nums text-foreground">{value}</dd>
      )}
    </div>
  );
}

export function reliabilityLabel(
  estimate: DvfMarketEstimate | null,
  useManualMarket: boolean,
): string {
  if (useManualMarket) return "personnelle, à confirmer";
  if (!estimate) return "à compléter";
  const confidence = marketReferenceConfidence(estimate).confidence;
  if (confidence === "high") return "solide";
  if (confidence === "low") return "fragile";
  return "indicative";
}
