import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle.js";

export type SearchPaginationProps = {
  hasMore: boolean;
  hasPrevious: boolean;
  isFetching: boolean;
  loadedCount: number;
  totalCount: number | undefined;
  mapListFollowsViewport: boolean;
  page: number;
  pageSize: number;
  onNext: () => void;
  onPrevious: () => void;
};

export function SearchPagination({
  hasMore,
  hasPrevious,
  isFetching,
  loadedCount,
  totalCount,
  mapListFollowsViewport,
  page,
  pageSize,
  onNext,
  onPrevious,
}: SearchPaginationProps) {
  if (!hasMore && !hasPrevious && loadedCount === 0) return null;

  const firstResult = loadedCount === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastResult = (page - 1) * pageSize + loadedCount;

  return (
    <nav
      className="flex flex-wrap items-center justify-center gap-3 px-4 pb-10 pt-2 text-center sm:px-5"
      aria-label="Pagination des ventes"
      aria-busy={isFetching}
    >
      {hasPrevious ? (
        <button
          type="button"
          onClick={onPrevious}
          disabled={isFetching}
          className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-md border border-[#cbd5df] bg-white px-4 text-sm font-bold text-[#132238] transition-colors hover:border-[#0f766e] hover:text-[#0f766e] disabled:cursor-not-allowed disabled:opacity-60"
        >
          Page précédente
        </button>
      ) : null}
      <span
        className="text-xs font-bold uppercase tracking-[0.16em] text-[#8b949e]"
        role="status"
        aria-live="polite"
      >
        {mapListFollowsViewport && totalCount != null && loadedCount < totalCount
          ? `${loadedCount.toLocaleString("fr-FR")} affichés / ${totalCount.toLocaleString(
              "fr-FR",
            )} dans la carte`
          : totalCount != null
            ? `${firstResult.toLocaleString("fr-FR")}–${lastResult.toLocaleString(
                "fr-FR",
              )} / ${totalCount.toLocaleString("fr-FR")} dossiers`
            : `Page ${page.toLocaleString("fr-FR")}`}
      </span>
      {hasMore ? (
        <button
          type="button"
          onClick={onNext}
          disabled={isFetching}
          className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-md border border-[#cbd5df] bg-white px-4 text-sm font-bold text-[#132238] transition-colors hover:border-[#0f766e] hover:text-[#0f766e] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isFetching ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
          {isFetching ? "Chargement..." : "Page suivante"}
        </button>
      ) : null}
    </nav>
  );
}
