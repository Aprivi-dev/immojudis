"use client";

import {
  ADMIN_PAGE_SIZE,
  adminKnownTotal,
  adminNextOffset,
  adminPageRange,
  adminPreviousOffset,
} from "@/lib/admin-pagination";

/**
 * Barre de pagination des listes admin (50 lignes par page, offset / limit côté serveur).
 * Masquée quand tout tient sur une page.
 */
export function AdminPagination({
  label,
  offset: rawOffset,
  limit: rawLimit,
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
  // Réponse incomplète (sans offset ni limit, en plus du total) : jamais « page NaN sur NaN ».
  const offset = Number.isFinite(rawOffset) ? rawOffset : 0;
  const limit = rawLimit > 0 ? rawLimit : ADMIN_PAGE_SIZE;
  const known = adminKnownTotal(total);
  // Sans total, seule une page pleine laisse supposer une suite.
  const hasNext = known == null ? shown >= limit : offset + limit < known;
  if (!hasNext && offset === 0) return null;
  const page = Math.floor(offset / limit) + 1;
  return (
    <nav
      aria-label={`Pagination — ${label}`}
      className={`flex flex-wrap items-center justify-between gap-3 border-t border-brand-navy/10 px-5 py-3 text-sm ${className}`}
    >
      <span className="text-brand-navy/60" role="status">
        {known == null
          ? `${shown ? `${offset + 1}–${offset + shown}` : "0"} · page ${page}`
          : `${adminPageRange({ offset, shown, total: known })} · page ${page} sur ${Math.max(1, Math.ceil(known / limit))}`}
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
          disabled={!hasNext || busy}
          onClick={() =>
            onOffsetChange(known == null ? offset + limit : adminNextOffset(offset, limit, known))
          }
        >
          Suivant
        </button>
      </div>
    </nav>
  );
}
