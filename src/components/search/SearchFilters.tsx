import ListFilter from "lucide-react/dist/esm/icons/list-filter.js";
import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle.js";
import Map from "lucide-react/dist/esm/icons/map.js";
import X from "lucide-react/dist/esm/icons/x.js";
import SearchIcon from "lucide-react/dist/esm/icons/search.js";
import { Skeleton } from "@/components/ui/skeleton";
import { SearchRejectedError } from "@/lib/search/search-errors";
import { userMessage } from "@/lib/user-messages";
import type { ActiveFilterChip } from "./active-filter-chips";

export function MobileMapToggle({
  activeFiltersCount,
  comparedCount = 0,
  onOpenFilters,
  onOpenComparison,
  onPreloadMap,
  onOpenMap,
}: {
  activeFiltersCount: number;
  /** Biens choisis pour la comparaison : au moins un, et la pastille « Comparer (N) » apparaît. */
  comparedCount?: number;
  onOpenFilters: () => void;
  onOpenComparison?: () => void;
  /** Appelé à l'appui du doigt sur « Carte » (avant le clic) pour télécharger la carte à l'avance. */
  onPreloadMap?: () => void;
  onOpenMap: () => void;
}) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-30 grid auto-cols-fr grid-flow-col gap-2 border-t border-brand-navy/10 bg-white/95 p-2 shadow-[0_-14px_34px_rgba(19,34,56,0.12)] backdrop-blur lg:hidden">
      <button
        type="button"
        onClick={onOpenFilters}
        className="inline-flex h-11 cursor-pointer items-center justify-center gap-2 rounded-md px-3 text-sm font-extrabold text-brand-navy transition-colors hover:bg-surface-muted"
      >
        <ListFilter className="h-4 w-4" />
        Filtres
        {activeFiltersCount > 0 ? (
          <span className="rounded-full bg-brand-navy px-1.5 py-0.5 text-[10px] text-white">
            {activeFiltersCount}
          </span>
        ) : null}
      </button>
      {comparedCount > 0 && onOpenComparison ? (
        <button
          type="button"
          onClick={onOpenComparison}
          data-comparison-pill=""
          className="inline-flex h-11 cursor-pointer items-center justify-center rounded-full border border-brand-navy bg-white px-3 text-sm font-extrabold text-brand-navy transition-colors hover:bg-surface-muted"
        >
          Comparer ({comparedCount})
        </button>
      ) : null}
      <button
        type="button"
        onClick={onOpenMap}
        onPointerDown={onPreloadMap}
        onTouchStart={onPreloadMap}
        className="inline-flex h-11 cursor-pointer items-center justify-center gap-2 rounded-md bg-brand-navy px-4 text-sm font-extrabold text-white transition-colors hover:bg-brand-navy-soft"
      >
        <Map className="h-4 w-4" />
        Carte
      </button>
    </div>
  );
}
export function NoResultsState({
  filters = [],
  onRemoveFilter,
  onReset,
  onShowFrance,
}: {
  /** Critères actifs : chacun peut être retiré seul. */
  filters?: ActiveFilterChip[];
  onRemoveFilter?: (filter: ActiveFilterChip) => void;
  onReset?: () => void;
  /** Proposé seulement si la recherche est limitée à un lieu. */
  onShowFrance?: () => void;
}) {
  return (
    <div className="rounded-md border border-line-soft bg-white p-6 text-center shadow-sm sm:p-10">
      <SearchIcon className="mx-auto h-8 w-8 text-brand-navy" />
      <h2 className="mt-4 text-xl font-extrabold text-brand-navy">Aucune vente trouvée</h2>
      <p className="mt-2 text-sm font-medium text-ink-soft">
        Aucune annonce référencée ne correspond à ces critères pour le moment. Essayez un autre type
        de vente, une autre zone ou élargissez votre budget.
      </p>
      {filters.length > 0 && onRemoveFilter ? (
        <ul aria-label="Critères actifs" className="mt-4 flex flex-wrap justify-center gap-2">
          {filters.map((filter) => (
            <li key={filter.key}>
              <button
                type="button"
                onClick={() => onRemoveFilter(filter)}
                aria-label={`Retirer le critère : ${filter.label}`}
                className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full border border-line bg-surface-muted px-3 text-sm font-semibold text-brand-navy hover:border-brand-navy"
              >
                {filter.label}
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {onReset || onShowFrance ? (
        <div className="mt-5 flex flex-wrap justify-center gap-3">
          {onReset && filters.length > 0 ? (
            <button
              type="button"
              onClick={onReset}
              className="inline-flex min-h-11 cursor-pointer items-center rounded-md bg-brand-navy px-4 text-sm font-semibold text-white hover:bg-brand-navy-soft"
            >
              Effacer les filtres
            </button>
          ) : null}
          {onShowFrance ? (
            <button
              type="button"
              onClick={onShowFrance}
              className="inline-flex min-h-11 cursor-pointer items-center rounded-md border border-line bg-white px-4 text-sm font-semibold text-brand-navy hover:border-brand-navy"
            >
              Voir toute la France
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  // Recherche refusée par la route (400) : la demande est en cause, pas le catalogue. La rejouer
  // donnerait la même réponse, donc pas de « Réessayer ».
  const rejected = error instanceof SearchRejectedError;
  return (
    <div
      role="alert"
      className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700"
    >
      <div>
        <p className="font-bold">
          {rejected
            ? "Cette recherche n’est pas possible."
            : "Le catalogue ne répond pas pour le moment."}
        </p>
        <p className="mt-1 font-medium">
          {userMessage(error, "Réessayez dans quelques secondes.")}
        </p>
      </div>
      {onRetry && !rejected ? (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex min-h-11 items-center rounded-md border border-red-300 bg-white px-3 py-1.5 text-sm font-bold text-red-700 hover:bg-red-100"
        >
          Réessayer
        </button>
      ) : null}
    </div>
  );
}

export function ListingCardSkeleton() {
  return (
    <div className="grid overflow-hidden rounded-md border border-line-soft bg-white shadow-sm sm:grid-cols-[12.5rem_1fr]">
      <Skeleton className="aspect-[1.5] w-full rounded-none bg-surface-tint sm:aspect-auto sm:min-h-[13rem]" />
      <div className="space-y-3 p-4">
        <div className="flex justify-between gap-3">
          <div className="flex-1 space-y-2">
            <Skeleton className="h-7 w-1/2 bg-surface-tint" />
            <Skeleton className="h-4 w-3/4 bg-surface-tint" />
          </div>
          <div className="flex gap-2">
            <Skeleton className="h-8 w-8 rounded-full bg-surface-tint" />
            <Skeleton className="h-8 w-8 rounded-full bg-surface-tint" />
          </div>
        </div>
        <Skeleton className="h-4 w-full bg-surface-tint" />
        <Skeleton className="h-4 w-4/5 bg-surface-tint" />
        <Skeleton className="h-5 w-24 bg-surface-tint" />
      </div>
    </div>
  );
}

export function MapPanelSkeleton() {
  return (
    <div className="grid h-full min-h-[28rem] place-items-center bg-surface-tint">
      <div
        role="status"
        className="inline-flex items-center gap-2 rounded-md border border-line bg-white px-4 py-3 text-sm font-bold text-brand-navy shadow-lg"
      >
        <LoaderCircle className="h-4 w-4 animate-spin text-brand-navy" />
        Chargement de la carte
      </div>
    </div>
  );
}

export function Footer() {
  return (
    <footer className="border-t border-brand-navy/10 px-4 py-8 text-xs font-semibold text-ink-soft sm:px-5">
      Les informations doivent être vérifiées dans les pièces officielles avant toute décision
      d’enchère.
    </footer>
  );
}
