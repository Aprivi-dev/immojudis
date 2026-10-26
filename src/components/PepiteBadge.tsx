"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Badge } from "@/components/ui/primitives";
import { escapeBelongsToAnotherLayer } from "@/lib/escape-layer";
import {
  PEPITE_ANCHOR,
  PEPITE_EXPLANATION,
  PEPITE_LABEL,
  PEPITE_METHOD_LINK_LABEL,
  PEPITE_METHOD_PATH,
} from "@/lib/pepite-copy";

/**
 * Pictogramme de pépite d'or : un caillou irrégulier à facettes (pas un diamant). Décoratif : le texte
 * « Pépite » qui l'accompagne porte le sens. Couleurs du système visuel (`gold`, `gold-light`, `gold-text`),
 * aucune couleur en dur ; aucune animation (aucun scintillement).
 */
export function PepiteIcon({ className = "size-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden="true" focusable="false">
      <path
        d="M2.5 6.8 5.6 3.2l4.9.5 3 3.4-1 4.6-4 2.3-4.6-1.4L2 9.2Z"
        className="fill-gold-light stroke-gold"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path
        d="M5.6 3.2 7.4 7.4 2.5 6.8M7.4 7.4l3.1-3.7M7.4 7.4l6.1-.3M7.4 7.4l1.1 6M7.4 7.4 3.9 12.4"
        className="fill-none stroke-gold-text"
        strokeWidth=".8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Pastille « Pépite » seule (fiche, légende) : logo or, texte en `gold-text`, jamais la couleur seule. */
export function PepitePill({ className }: { className?: string }) {
  return (
    <Badge tone="pepite" className={className} data-testid="pepite-badge">
      <PepiteIcon />
      {PEPITE_LABEL}
    </Badge>
  );
}

/** Pastille « Pépite » du haut de la fiche, avec le lien « Pourquoi ? » vers le bloc de la fiche (`#pepite`). */
export function PepiteHeroBadge() {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2">
      <PepitePill />
      <a
        href={`#${PEPITE_ANCHOR}`}
        className="inline-flex min-h-11 items-center text-sm font-semibold text-gold-text underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft"
      >
        Pourquoi ?
      </a>
    </span>
  );
}

/** Le texte que la pastille et son bouton « i » affichent : ce que le repère est, et ce qu'il n'est pas. */
export function PepiteExplanation({ id, className }: { id?: string; className?: string }) {
  return (
    <div id={id} role="note" className={className}>
      <p>{PEPITE_EXPLANATION}</p>
      <Link
        href={PEPITE_METHOD_PATH}
        prefetch={false}
        className="mt-1 inline-flex min-h-11 items-center font-semibold text-gold-text underline underline-offset-4"
      >
        {PEPITE_METHOD_LINK_LABEL}
      </Link>
    </div>
  );
}

/** Largeur de la fenêtre d'aide (16 rem) et marge au bord de l'écran, en pixels. */
const PANEL_WIDTH = 256;
const EDGE = 8;

/**
 * Pastille « Pépite » d'une carte de résultats, sur la photo. C'est aussi un bouton (clavier, toucher) qui
 * ouvre l'explication : ce que le repère est (calculé automatiquement, sur des critères publics) et ce qu'il
 * n'est pas (ni conseil, ni recommandation d'acheter, ni garantie de prix), avec le lien vers la méthode.
 *
 * La fenêtre est rendue dans `document.body`, en position fixe sous la pastille : ni la photo (`overflow-hidden`)
 * ni le tableau (`overflow-x-auto`) ne la rognent, et elle reste dans l'écran d'une carte étroite. Elle se ferme à
 * Échap (sauf si un dialogue ouvert par-dessus a déjà pris l'Échap), à un appui à l'extérieur, quand le focus la
 * quitte, au défilement et au redimensionnement ; un second appui sur la pastille la ferme aussi.
 * `variant="icon"` : la colonne « Statut » du tableau n'a pas la place du libellé : une icône, dont le nom
 * accessible est « Pépite ».
 */
export function PepiteInfoBadge({ variant = "pill" }: { variant?: "pill" | "icon" }) {
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const open = position !== null;
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  const close = () => setPosition(null);
  const toggle = () => {
    if (open) return close();
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const left = Math.max(EDGE, Math.min(rect.left, window.innerWidth - PANEL_WIDTH - EDGE));
    setPosition({ top: rect.bottom + 4, left });
  };

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || escapeBelongsToAnotherLayer(event, trigger.current)) return;
      setPosition(null);
      trigger.current?.focus();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (trigger.current?.contains(target) || panel.current?.contains(target))) return;
      setPosition(null);
    };
    const onViewportChange = () => setPosition(null);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("scroll", onViewportChange, true);
    window.addEventListener("resize", onViewportChange);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("scroll", onViewportChange, true);
      window.removeEventListener("resize", onViewportChange);
    };
  }, [open]);

  const focus =
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft";
  return (
    <span
      className="relative inline-flex"
      // Le focus quitte la pastille et sa fenêtre (la fenêtre, dans un portail, remonte ici par React).
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null;
        if (next && (trigger.current?.contains(next) || panel.current?.contains(next))) return;
        // Pas de focus cible (appui sur du texte de la fenêtre) : `pointerdown` décide.
        if (next) close();
      }}
    >
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={toggle}
        className={`relative z-20 rounded-full after:absolute after:-inset-2 after:content-[''] ${focus}`}
      >
        {variant === "icon" ? (
          <span className="inline-flex size-6 items-center justify-center rounded-full border border-gold bg-white">
            <PepiteIcon className="size-3.5" />
            <span className="sr-only">{PEPITE_LABEL}</span>
          </span>
        ) : (
          <PepitePill />
        )}
      </button>
      {position
        ? createPortal(
            <div
              ref={panel}
              tabIndex={-1}
              style={{ top: position.top, left: position.left, width: PANEL_WIDTH }}
              className="fixed z-[70] max-w-[calc(100vw-1rem)] rounded-lg border border-line-soft bg-white p-3 text-xs leading-relaxed text-foreground shadow-lg outline-none"
            >
              <PepiteExplanation id={id} />
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}
