/** Pagination Précédent / Suivant des tableaux admin paginés par décalage. */
export function AdminPrevNextPagination({
  offset,
  count,
  totalCount,
  hasMore,
  busy,
  onPrevious,
  onNext,
}: {
  offset: number;
  count: number;
  totalCount: number;
  hasMore: boolean;
  busy: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
      <span>
        {offset + 1}–{offset + count} sur {totalCount}
      </span>
      <div className="flex gap-2">
        <button
          type="button"
          className="admin-panel rounded-lg px-3 py-2 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={busy || offset === 0}
          onClick={onPrevious}
        >
          Précédent
        </button>
        <button
          type="button"
          className="admin-panel rounded-lg px-3 py-2 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={busy || !hasMore}
          onClick={onNext}
        >
          Suivant
        </button>
      </div>
    </div>
  );
}
