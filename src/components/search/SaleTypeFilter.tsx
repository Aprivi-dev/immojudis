import { Link } from "@/lib/router-compat";
import { visibleSaleTypeOptions, type SaleTypeFilter as SaleTypeValue } from "@/lib/sale-types";

export function SaleTypeFilter({
  value,
  onChange,
  compact = false,
}: {
  value: SaleTypeValue | "";
  compact?: boolean;
  onChange: (value: SaleTypeValue | "") => void;
}) {
  return (
    <fieldset className="min-w-0 border-0 p-0">
      <legend className={compact ? "sr-only" : "mb-2 text-xs font-semibold text-ink-soft"}>
        Type de vente
      </legend>
      <div
        className={
          compact ? "flex flex-wrap items-center gap-1.5" : "flex flex-wrap items-center gap-2"
        }
      >
        {[{ value: "" as const, label: "Toutes" }, ...visibleSaleTypeOptions()].map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={value === option.value}
            onClick={() => onChange(option.value)}
            className={`min-h-9 shrink-0 cursor-pointer whitespace-nowrap rounded-full border px-3 py-1.5 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2 ${
              value === option.value
                ? "border-brand-navy bg-brand-navy text-white"
                : "border-line bg-white text-brand-navy hover:border-brand-navy"
            }`}
          >
            {option.label}
          </button>
        ))}
        {!compact && (
          <Link
            href="/ventes-immobilieres-judiciaires#differences"
            className="px-1 py-2 text-xs font-semibold text-brand-navy underline underline-offset-4"
          >
            Quelle différence ?
          </Link>
        )}
      </div>
    </fieldset>
  );
}
