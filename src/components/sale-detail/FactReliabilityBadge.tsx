import type { FactPresentationKind, FactReliabilityMap, KeyFact } from "@/lib/fact-reliability";
import { getFactPresentation, getFactReliabilityForDisplay } from "@/lib/fact-reliability";
import type { AuctionSale } from "@/lib/types";

const PRESENTATION_CLASSES: Record<FactPresentationKind, string> = {
  documented: "border-emerald-200 bg-emerald-50 text-emerald-800",
  reported: "border-slate-200 bg-slate-50 text-slate-700",
  missing: "border-slate-200 bg-slate-50 text-slate-700",
  estimated: "border-sky-200 bg-sky-50 text-sky-800",
  review: "border-amber-200 bg-amber-50 text-amber-900",
  conflict: "border-rose-200 bg-rose-50 text-rose-900",
};

export function FactReliabilityBadge({
  sale,
  field,
  displayedValue,
  facts,
  blockedByAiReview = false,
}: {
  sale: AuctionSale;
  field: KeyFact;
  displayedValue?: string | null;
  facts?: FactReliabilityMap | null;
  blockedByAiReview?: boolean;
}) {
  if (blockedByAiReview) return null;

  const fact = getFactReliabilityForDisplay(sale, field, displayedValue, facts);
  const presentation = getFactPresentation(sale, field, displayedValue, facts);
  return (
    <span
      role="note"
      aria-label={`${fact.label} : ${presentation.label}. ${presentation.detail}`}
      title={presentation.detail}
      data-fact-field={field}
      data-fact-status={fact.status}
      data-fact-kind={presentation.kind}
      className={`ml-2 inline-flex w-fit items-center rounded-full border px-2 py-0.5 align-middle text-[10px] font-semibold leading-4 tracking-wide ${PRESENTATION_CLASSES[presentation.kind]}`}
    >
      {presentation.label}
    </span>
  );
}
