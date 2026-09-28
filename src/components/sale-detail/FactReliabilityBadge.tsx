import type { FactReliabilityMap, KeyFact } from "@/lib/fact-reliability";
import { getFactReliabilityForDisplay } from "@/lib/fact-reliability";
import type { AuctionSale } from "@/lib/types";

const STATUS_CLASSES = {
  observed: "border-emerald-200 bg-emerald-50 text-emerald-800",
  inferred: "border-sky-200 bg-sky-50 text-sky-800",
  to_confirm: "border-amber-200 bg-amber-50 text-amber-900",
  conflict: "border-rose-200 bg-rose-50 text-rose-900",
} as const;

export function FactReliabilityBadge({
  sale,
  field,
  displayedValue,
  facts,
}: {
  sale: AuctionSale;
  field: KeyFact;
  displayedValue?: string | null;
  facts?: FactReliabilityMap | null;
}) {
  const fact = getFactReliabilityForDisplay(sale, field, displayedValue, facts);
  return (
    <span
      role="note"
      aria-label={`${fact.label} : ${fact.statusLabel}. ${fact.detail}`}
      title={fact.detail}
      data-fact-field={field}
      data-fact-status={fact.status}
      className={`ml-2 inline-flex items-center rounded-full border px-2 py-0.5 align-middle text-[10px] font-semibold leading-4 tracking-wide ${STATUS_CLASSES[fact.status]}`}
    >
      {fact.statusLabel}
    </span>
  );
}
