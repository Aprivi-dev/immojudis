import Link from "next/link";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.js";
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

/**
 * Le type de vente en liste déroulante, segment du contrôle « Tri et type de vente » de /sales
 * (`SortAndSaleTypeControl`) : « Toutes » ou l'un des types, comme les pastilles de `SaleTypeFilter`.
 */
export function SaleTypeSelect({
  value,
  onChange,
}: {
  value: SaleTypeValue | "";
  onChange: (value: SaleTypeValue | "") => void;
}) {
  return (
    <label className="relative inline-flex min-h-11 min-w-0 flex-[2] items-center focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-gold-soft">
      <span className="sr-only">Type de vente</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as SaleTypeValue | "")}
        className="h-full w-full min-w-0 cursor-pointer appearance-none text-ellipsis bg-transparent py-0 pl-3 pr-9 text-sm font-bold text-brand-navy outline-none"
      >
        <option value="">Toutes les ventes</option>
        {visibleSaleTypeOptions().map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 h-4 w-4 text-ink-soft" />
    </label>
  );
}
