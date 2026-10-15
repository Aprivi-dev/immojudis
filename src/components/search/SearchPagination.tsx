import type { MouseEvent, ReactNode } from "react";
import Link from "next/link";
import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle.js";

const PAGE_CONTROL_CLASSES =
  "inline-flex h-11 cursor-pointer items-center justify-center gap-2 rounded-md border border-line bg-white px-4 text-sm font-bold text-brand-navy transition-colors hover:border-brand-navy hover:text-brand-navy aria-disabled:cursor-not-allowed aria-disabled:opacity-60";

/**
 * A page change is a real link (`?page=N`) when its address is known: crawlers and "open in a new
 * tab" follow it. A plain click keeps the client behaviour (the list is updated in place, without
 * a page load); a click with a modifier key or a non-primary button follows the link normally.
 * Without an address it stays a button.
 */
function PageControl({
  href,
  disabled,
  onActivate,
  rel,
  children,
}: {
  href: string | undefined;
  disabled: boolean;
  onActivate: () => void;
  rel?: "next" | "prev";
  children: ReactNode;
}) {
  if (!href) {
    return (
      <button
        type="button"
        onClick={onActivate}
        disabled={disabled}
        aria-disabled={disabled}
        className={PAGE_CONTROL_CLASSES}
      >
        {children}
      </button>
    );
  }
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (disabled) {
      event.preventDefault();
      return;
    }
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    onActivate();
  };
  return (
    <Link
      href={href}
      rel={rel}
      prefetch={false}
      aria-disabled={disabled || undefined}
      onClick={handleClick}
      className={PAGE_CONTROL_CLASSES}
    >
      {children}
    </Link>
  );
}

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
  /** Address of the next / previous page (`/sales?…&page=N`): turns the buttons into links. */
  nextHref?: string;
  previousHref?: string;
  /** Pour revenir au début quand la page demandée dépasse la dernière. */
  onFirstPage?: () => void;
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
  nextHref,
  previousHref,
  onFirstPage,
}: SearchPaginationProps) {
  if (!hasMore && !hasPrevious && loadedCount === 0) return null;

  // Page au-delà de la dernière (lien ancien, résultats qui ont diminué) : on le dit et on
  // propose le retour au début plutôt qu'un compteur « 0–48 / 40 dossiers ».
  if (page > 1 && loadedCount === 0 && !isFetching) {
    return (
      <nav
        className="flex flex-wrap items-center justify-center gap-3 px-4 pb-10 pt-2 text-center sm:px-5"
        aria-label="Pagination des ventes"
      >
        <span className="text-sm font-semibold text-ink-soft" role="status">
          Aucun résultat sur cette page
        </span>
        {onFirstPage ? (
          <button
            type="button"
            onClick={onFirstPage}
            className="inline-flex min-h-11 cursor-pointer items-center justify-center rounded-md border border-line bg-white px-4 text-sm font-bold text-brand-navy transition-colors hover:border-brand-navy"
          >
            Revenir à la page 1
          </button>
        ) : null}
      </nav>
    );
  }

  const firstResult = loadedCount === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastResult = (page - 1) * pageSize + loadedCount;

  return (
    <nav
      className="flex flex-wrap items-center justify-center gap-3 px-4 pb-10 pt-2 text-center sm:px-5"
      aria-label="Pagination des ventes"
      aria-busy={isFetching}
    >
      {hasPrevious ? (
        <PageControl href={previousHref} rel="prev" disabled={isFetching} onActivate={onPrevious}>
          Page précédente
        </PageControl>
      ) : null}
      <span
        className="text-xs font-bold uppercase tracking-[0.16em] text-ink-soft"
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
        <PageControl href={nextHref} rel="next" disabled={isFetching} onActivate={onNext}>
          {isFetching ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
          {isFetching ? "Chargement..." : "Page suivante"}
        </PageControl>
      ) : null}
    </nav>
  );
}
