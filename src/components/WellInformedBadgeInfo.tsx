"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import FileText from "lucide-react/dist/esm/icons/file-text.js";
import Info from "lucide-react/dist/esm/icons/info.js";
import {
  WELL_INFORMED_BADGE_LABEL,
  WELL_INFORMED_BADGE_LINK_LABEL,
  WELL_INFORMED_BADGE_NOTE,
  WELL_INFORMED_BADGE_PAGE,
} from "./well-informed-copy";

/**
 * Pastille « Annonce bien renseignée » et sa note. Le libellé est visible et porté par la
 * pastille ; l'icône est décorative. La réserve (ni vérification ni garantie) s'ouvre au toucher
 * comme au clavier avec le bouton « i » : la note apparaît sous la pastille, avec un lien vers la
 * page du classement. Fermeture avec Échap ou en rappuyant sur le bouton.
 */
export function WellInformedBadgeInfo() {
  const [open, setOpen] = useState(false);
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    <>
      <span className="inline-flex items-center gap-1.5 rounded-full border border-gold/40 bg-gold/10 py-1 pl-2.5 pr-1.5 text-xs font-semibold text-gold-text">
        <FileText className="h-3.5 w-3.5" aria-hidden />
        <span>{WELL_INFORMED_BADGE_LABEL}</span>
        <button
          ref={trigger}
          type="button"
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          aria-label={`À propos du repère « ${WELL_INFORMED_BADGE_LABEL} »`}
          onClick={() => setOpen((current) => !current)}
          className="relative z-20 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full hover:bg-gold/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold after:absolute after:-inset-3 after:content-['']"
        >
          <Info className="h-3.5 w-3.5" aria-hidden />
        </button>
      </span>
      {open ? (
        <span
          id={id}
          role="note"
          className="relative z-20 block w-full rounded-lg border border-line-soft bg-surface-muted p-3 text-xs leading-relaxed text-foreground"
        >
          {WELL_INFORMED_BADGE_NOTE}{" "}
          <Link
            href={WELL_INFORMED_BADGE_PAGE}
            className="inline-flex min-h-11 items-center font-semibold text-gold-text underline underline-offset-4"
          >
            {WELL_INFORMED_BADGE_LINK_LABEL}
          </Link>
        </span>
      ) : null}
    </>
  );
}
