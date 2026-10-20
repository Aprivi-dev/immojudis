import type { MouseEvent, ReactNode } from "react";
import Link from "next/link";
import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle.js";

/** Gabarit commun des contrôles de pagination, sans couleur : chaque liste garde la sienne. */
const PAGE_CONTROL_BASE_CLASSES =
  "inline-flex h-11 items-center justify-center gap-2 rounded-md border px-4 text-sm font-bold transition-colors";

const PAGE_CONTROL_CLASSES = `${PAGE_CONTROL_BASE_CLASSES} cursor-pointer border-line bg-white text-brand-navy hover:border-brand-navy hover:text-brand-navy aria-disabled:cursor-not-allowed aria-disabled:opacity-60`;

/** Pastille d'un numéro de page : même hauteur de 44 px, largeur minimale d'un doigt. */
const PAGE_NUMBER_CLASSES = `${PAGE_CONTROL_CLASSES} min-w-11 px-2`;

/**
 * Page courante : fond marine, texte blanc. Liste distincte de `PAGE_CONTROL_CLASSES` : mêlées,
 * `bg-white` l'emportait sur `bg-brand-navy` et le numéro blanc restait invisible.
 */
const CURRENT_PAGE_CLASSES = `${PAGE_CONTROL_BASE_CLASSES} min-w-11 border-brand-navy bg-brand-navy px-2 text-white`;

/** Identifiant de la pagination : cible du lien d'évitement « Aller à la pagination ». */
export const SALES_PAGINATION_ID = "sales-pagination";

/**
 * Plus grand décalage lu par la recherche publique (`RPC_LIMITS.maxOffset`) : au-delà, la route
 * refuse la page. Les numéros proposés s'arrêtent donc là.
 */
const MAX_OFFSET = 10_000;

/** Un numéro de page, ou « … » pour les pages sautées. */
export type PageItem = number | "gap";

/**
 * Numéros affichés : la première page, les deux suivantes, la dernière et la page courante avec ses
 * voisines. Un trou d'une seule page est comblé (« 1 2 3 4 … » plutôt que « 1 2 3 … 5 »).
 */
export function visiblePages(page: number, totalPages: number): PageItem[] {
  const wanted = new Set<number>();
  for (const candidate of [1, 2, 3, totalPages, page - 1, page, page + 1]) {
    if (candidate >= 1 && candidate <= totalPages) wanted.add(candidate);
  }
  const sorted = [...wanted].sort((a, b) => a - b);
  const items: PageItem[] = [];
  sorted.forEach((value, index) => {
    const previous = sorted[index - 1];
    if (previous !== undefined && value - previous === 2) items.push(previous + 1);
    else if (previous !== undefined && value - previous > 2) items.push("gap");
    items.push(value);
  });
  return items;
}

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
  className = PAGE_CONTROL_CLASSES,
  ariaLabel,
  children,
}: {
  href: string | undefined;
  disabled: boolean;
  onActivate: () => void;
  rel?: "next" | "prev";
  className?: string;
  ariaLabel?: string;
  children: ReactNode;
}) {
  if (!href) {
    return (
      <button
        type="button"
        onClick={onActivate}
        disabled={disabled}
        aria-disabled={disabled}
        aria-label={ariaLabel}
        className={className}
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
      aria-label={ariaLabel}
      onClick={handleClick}
      className={className}
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
  /**
   * Address of any page of the search, and the client action for a plain click on it: the numbered
   * links (1, 2, 3, …, last) are real `<a href>` when both are given.
   */
  pageHref?: (page: number) => string | undefined;
  onGoToPage?: (page: number) => void;
  /** Pour revenir au début quand la page demandée dépasse la dernière. */
  onFirstPage?: () => void;
  /** Address of page 1: « Revenir à la page 1 » is then a real link. */
  firstHref?: string;
  /** La route a refusé la page (hors bornes) : le message le dit, sans parler de résultats vides. */
  outOfRange?: boolean;
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
  pageHref,
  onGoToPage,
  onFirstPage,
  firstHref,
  outOfRange = false,
}: SearchPaginationProps) {
  if (!hasMore && !hasPrevious && loadedCount === 0) return null;

  // Page au-delà de la dernière (lien ancien, résultats qui ont diminué) : on le dit et on
  // propose le retour au début plutôt qu'un compteur « 0–48 / 40 ventes ».
  if (page > 1 && loadedCount === 0 && !isFetching) {
    return (
      <nav
        id={SALES_PAGINATION_ID}
        tabIndex={-1}
        className="flex flex-wrap items-center justify-center gap-3 px-4 pb-10 pt-2 text-center outline-none sm:px-5"
        aria-label="Pagination des ventes"
      >
        <span className="text-sm font-semibold text-ink-soft" role="status">
          {outOfRange
            ? "Cette page n’existe pas pour cette recherche"
            : "Aucun résultat sur cette page"}
        </span>
        {onFirstPage ? (
          <PageControl
            href={firstHref}
            disabled={false}
            onActivate={onFirstPage}
            className="inline-flex min-h-11 cursor-pointer items-center justify-center rounded-md border border-line bg-white px-4 text-sm font-bold text-brand-navy transition-colors hover:border-brand-navy"
          >
            Revenir à la page 1
          </PageControl>
        ) : null}
      </nav>
    );
  }

  const firstResult = loadedCount === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastResult = (page - 1) * pageSize + loadedCount;
  const totalPages =
    totalCount != null && pageSize > 0 && !mapListFollowsViewport
      ? Math.min(Math.ceil(totalCount / pageSize), Math.floor(MAX_OFFSET / pageSize) + 1)
      : 0;
  const numbered = totalPages > 1 && pageHref && onGoToPage ? visiblePages(page, totalPages) : [];

  return (
    <nav
      id={SALES_PAGINATION_ID}
      tabIndex={-1}
      className="flex flex-wrap items-center justify-center gap-3 px-4 pb-10 pt-2 text-center outline-none sm:px-5"
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
              )} / ${totalCount.toLocaleString("fr-FR")} ventes`
            : `Page ${page.toLocaleString("fr-FR")}`}
      </span>
      {hasMore ? (
        <PageControl href={nextHref} rel="next" disabled={isFetching} onActivate={onNext}>
          {isFetching ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
          {isFetching ? "Chargement..." : "Page suivante"}
        </PageControl>
      ) : null}
      {numbered.length > 0 ? (
        <ol className="order-last flex w-full flex-wrap items-center justify-center gap-1.5">
          {numbered.map((item, index) =>
            item === "gap" ? (
              <li key={`gap-${index}`} aria-hidden="true" className="px-1 text-ink-soft">
                …
              </li>
            ) : (
              <li key={item}>
                {item === page ? (
                  // Pas d'`aria-label` sur un `span` (rôle générique) : le contexte est du texte masqué.
                  <span aria-current="page" className={CURRENT_PAGE_CLASSES}>
                    <span className="sr-only">Page </span>
                    {item.toLocaleString("fr-FR")}
                    <span className="sr-only">, page actuelle</span>
                  </span>
                ) : (
                  <PageControl
                    href={pageHref?.(item)}
                    disabled={isFetching}
                    onActivate={() => onGoToPage?.(item)}
                    className={PAGE_NUMBER_CLASSES}
                    ariaLabel={`Page ${item}`}
                  >
                    {item.toLocaleString("fr-FR")}
                  </PageControl>
                )}
              </li>
            ),
          )}
        </ol>
      ) : null}
    </nav>
  );
}
