import ListFilter from "lucide-react/dist/esm/icons/list-filter.js";
import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle.js";
import Map from "lucide-react/dist/esm/icons/map.js";
import SearchIcon from "lucide-react/dist/esm/icons/search.js";
import { Skeleton } from "@/components/ui/skeleton";
import { userMessage } from "@/lib/user-messages";

export function MobileMapToggle({
  activeFiltersCount,
  onOpenFilters,
  onOpenMap,
}: {
  activeFiltersCount: number;
  onOpenFilters: () => void;
  onOpenMap: () => void;
}) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-2 gap-2 border-t border-brand-navy/10 bg-white/95 p-2 shadow-[0_-14px_34px_rgba(19,34,56,0.12)] backdrop-blur lg:hidden">
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
      <button
        type="button"
        onClick={onOpenMap}
        className="inline-flex h-11 cursor-pointer items-center justify-center gap-2 rounded-md bg-brand-navy px-4 text-sm font-extrabold text-white transition-colors hover:bg-brand-navy-soft"
      >
        <Map className="h-4 w-4" />
        Carte
      </button>
    </div>
  );
}
export function NoResultsState() {
  return (
    <div className="rounded-md border border-line-soft bg-white p-10 text-center shadow-sm">
      <SearchIcon className="mx-auto h-8 w-8 text-brand-navy" />
      <h2 className="mt-4 text-xl font-extrabold text-brand-navy">Aucun dossier trouvé</h2>
      <p className="mt-2 text-sm font-medium text-ink-soft">
        Aucune annonce référencée ne correspond à ces critères pour le moment. Essayez un autre type
        de vente, une autre zone ou élargissez votre budget.
      </p>
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700"
    >
      <div>
        <p className="font-bold">Le catalogue ne répond pas pour le moment.</p>
        <p className="mt-1 font-medium">
          {userMessage(error, "Réessayez dans quelques secondes.")}
        </p>
      </div>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-sm font-bold text-red-700 hover:bg-red-100"
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
      <div className="inline-flex items-center gap-2 rounded-md border border-line bg-white px-4 py-3 text-sm font-bold text-brand-navy shadow-lg">
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
