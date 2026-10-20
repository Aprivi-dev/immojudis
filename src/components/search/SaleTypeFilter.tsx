import Link from "next/link";
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
            className={`min-h-11 shrink-0 cursor-pointer whitespace-nowrap rounded-full border px-3 py-1.5 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft ${
              value === option.value
                ? "border-brand-navy bg-brand-navy text-white"
                : "border-line bg-white text-brand-navy hover:border-brand-navy"
            }`}
          >
            {option.label}
          </button>
        ))}
        <Link
          href="/ventes-immobilieres-judiciaires#differences"
          // Affiché sur chaque visite de /sales : pas de préchargement de la page d'explication.
          prefetch={false}
          className="inline-flex min-h-11 items-center px-1 py-2 text-xs font-semibold text-brand-navy underline underline-offset-4"
        >
          Quelle différence ?
        </Link>
      </div>
    </fieldset>
  );
}
