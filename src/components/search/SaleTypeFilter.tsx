import Link from "next/link";
import { visibleSaleTypeOptions, type SaleTypeFilter as SaleTypeValue } from "@/lib/sale-types";
import { FORCED_COLORS_SELECTED } from "./forced-colors";

/**
 * Types de vente en pastilles (« Toutes », « Au tribunal », « Chez le notaire »…) : la pastille
 * pleine est celle qui est choisie (`aria-pressed`). Chaque pastille mesure 44 px de haut.
 *
 * - `compact` : sans légende visible (la légende reste lue par les lecteurs d'écran) ;
 * - `bar` : la rangée de la barre de filtres de /sales, qui défile sur mobile au lieu de passer
 *   à la ligne.
 *
 * Aucun nombre par type : le compter demanderait une recherche de plus par type à chaque changement
 * de filtre. Le total de la recherche est dans le titre et la barre de liste.
 */
export function SaleTypeFilter({
  value,
  onChange,
  compact = false,
  bar = false,
}: {
  value: SaleTypeValue | "";
  compact?: boolean;
  bar?: boolean;
  onChange: (value: SaleTypeValue | "") => void;
}) {
  return (
    <fieldset className="min-w-0 border-0 p-0">
      <legend className={compact || bar ? "sr-only" : "mb-2 text-xs font-semibold text-ink-soft"}>
        Type de vente
      </legend>
      <div
        className={
          bar
            ? "-mx-4 flex items-center gap-2 overflow-x-auto px-4 pb-0.5 [scrollbar-width:none] lg:mx-0 lg:flex-wrap lg:overflow-visible lg:px-0"
            : compact
              ? "flex flex-wrap items-center gap-1.5"
              : "flex flex-wrap items-center gap-2"
        }
      >
        {[{ value: "" as const, label: "Toutes" }, ...visibleSaleTypeOptions()].map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={value === option.value}
            onClick={() => onChange(option.value)}
            className={`min-h-11 shrink-0 cursor-pointer whitespace-nowrap rounded-full border px-4 py-1.5 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft ${
              value === option.value
                ? `border-brand-navy bg-brand-navy text-white ${FORCED_COLORS_SELECTED}`
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
          className={`inline-flex min-h-11 shrink-0 items-center whitespace-nowrap px-1 py-2 font-semibold underline underline-offset-4 ${
            bar ? "text-sm text-gold-text hover:text-brand-navy" : "text-xs text-brand-navy"
          }`}
        >
          Quelle différence ?
        </Link>
      </div>
    </fieldset>
  );
}
