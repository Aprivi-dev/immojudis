"use client";

import { adminNextOffset, adminPageRange, adminPreviousOffset } from "@/lib/admin-pagination";

/**
 * Barre de pagination des listes admin (50 lignes par page, offset / limit côté serveur).
 * Masquée quand tout tient sur une page.
 */
export function AdminPagination({
  label,
  offset,
  limit,
  total,
  shown,
  busy = false,
  onOffsetChange,
  className = "",
}: {
  /** Nom de la liste, repris dans le nom accessible des boutons. */
  label: string;
  offset: number;
  limit: number;
  total: number;
  /** Nombre de lignes réellement affichées sur la page courante. */
  shown: number;
  busy?: boolean;
  onOffsetChange: (offset: number) => void;
  className?: string;
}) {
  if (total <= limit && offset === 0) return null;
  const page = Math.floor(offset / limit) + 1;
  const pages = Math.max(1, Math.ceil(total / limit));
  return (
    <nav
      aria-label={`Pagination — ${label}`}
      className={`flex flex-wrap items-center justify-between gap-3 border-t border-brand-navy/10 px-5 py-3 text-sm ${className}`}
    >
      <span className="text-brand-navy/60" role="status">
        {adminPageRange({ offset, shown, total })} · page {page} sur {pages}
      </span>
      <div className="flex gap-2">
        <button
          type="button"
          className="admin-button-secondary"
          aria-label={`Précédent — ${label}`}
          disabled={offset === 0 || busy}
          onClick={() => onOffsetChange(adminPreviousOffset(offset, limit))}
        >
          Précédent
        </button>
        <button
          type="button"
          className="admin-button-secondary"
          aria-label={`Suivant — ${label}`}
          disabled={offset + limit >= total || busy}
          onClick={() => onOffsetChange(adminNextOffset(offset, limit, total))}
        >
          Suivant
        </button>
      </div>
    </nav>
  );
}
