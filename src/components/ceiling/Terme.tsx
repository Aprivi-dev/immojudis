"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import CircleHelp from "lucide-react/dist/esm/icons/circle-help.js";
import type { TermeEntry } from "./termes-definitions";

/**
 * Libellés des termes, seuls nécessaires au premier rendu (mot affiché, `aria-label`). Les
 * définitions (`termes-definitions.ts`) ne sont chargées qu'au premier survol, focus ou clic ; un
 * test vérifie que ces libellés restent identiques aux leurs.
 */
export const TERME_LABELS: Record<TermeKey, string> = {
  "mise-a-prix": "mise à prix",
  adjudication: "adjudication",
  surenchere: "surenchère",
  "avocat-poursuivant": "avocat poursuivant",
  consignation: "consignation du prix",
  "enchere-plafond": "enchère plafond",
  "offre-plafond": "offre plafond",
  "vente-bougie": "vente à la bougie",
  "vente-interactive": "vente notariale interactive",
  "premiere-offre": "première offre possible",
  liberation: "libération du bien",
  portage: "portage",
  emoluments: "émoluments",
  "garantie-encherir": "garantie pour enchérir",
  "frais-prealables": "frais préalables",
  "proces-verbal-descriptif": "procès-verbal descriptif",
  "cahier-conditions-vente": "cahier des conditions de vente",
  "droit-preemption": "droit de préemption",
};

type Definitions = typeof import("./termes-definitions");

let definitions: Promise<Definitions> | null = null;

/**
 * Un seul téléchargement des définitions pour toutes les bulles de la page. Un échec n'est pas
 * gardé en mémoire : le prochain survol ou clic retente le chargement.
 */
function loadDefinitions(): Promise<Definitions> {
  definitions ??= import("./termes-definitions").catch((error: unknown) => {
    definitions = null;
    throw error;
  });
  return definitions;
}

export type TermeKey =
  | "mise-a-prix"
  | "adjudication"
  | "surenchere"
  | "avocat-poursuivant"
  | "consignation"
  | "enchere-plafond"
  | "offre-plafond"
  | "vente-bougie"
  | "vente-interactive"
  | "premiere-offre"
  | "liberation"
  | "portage"
  | "emoluments"
  | "garantie-encherir"
  | "frais-prealables"
  | "proces-verbal-descriptif"
  | "cahier-conditions-vente"
  | "droit-preemption";

const GUIDE_PATH = "/ventes-immobilieres-judiciaires";

/** Lien vers l'entrée précise du lexique quand le terme y figure, vers le lexique sinon. */
function guideHref(entry: TermeEntry): string {
  return entry.href ?? `${GUIDE_PATH}#${entry.anchor ?? "lexique"}`;
}

/** Décale la bulle vers la gauche si elle dépasse du bord droit de l'écran (mot en fin de ligne). */
function keepInViewport(node: HTMLSpanElement | null) {
  if (!node) return;
  node.style.transform = "";
  const overflow = node.getBoundingClientRect().right - (window.innerWidth - 8);
  if (overflow > 0) node.style.transform = `translateX(-${Math.ceil(overflow)}px)`;
}

/**
 * Un mot du métier suivi d'une petite bulle d'aide : un bouton qui ouvre une définition courte et
 * un lien vers le guide. Fermeture à la touche Échap, au clic extérieur ou quand le focus sort.
 * L'icône reste petite (16 px) mais la zone d'appui fait 44 px.
 */
export function Terme({
  terme,
  children,
  bare = false,
  placement = "bottom",
}: {
  terme: TermeKey;
  children?: ReactNode;
  /** N'affiche que le bouton « ? » : le mot est déjà écrit à côté (titre, libellé d'un autre composant). */
  bare?: boolean;
  /** `top` ouvre la bulle au-dessus du mot, pour un mot proche du bas d'un conteneur qui rogne. */
  placement?: "bottom" | "top";
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const label = TERME_LABELS[terme];
  const [termes, setTermes] = useState<Definitions["TERMES"] | null>(null);
  const entry = termes?.[terme];

  /** Précharge au survol et au focus ; à l'ouverture, un échec referme la bulle (`onFailure`). */
  const loadEntry = (onFailure?: () => void) => {
    if (termes) return;
    loadDefinitions().then(
      (module) => setTermes(module.TERMES),
      (error: unknown) => {
        console.error("[terme] Chargement des définitions en échec", String(error));
        onFailure?.();
      },
    );
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <span
      ref={root}
      className="relative inline-flex items-center gap-1"
      onBlur={(event) => {
        if (!root.current?.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      {bare ? null : <span>{children ?? label}</span>}
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        aria-controls={id}
        aria-label={`Définition : ${label}`}
        onPointerEnter={() => loadEntry()}
        onFocus={() => loadEntry()}
        onClick={() => {
          if (!open) loadEntry(() => setOpen(false));
          setOpen((current) => !current);
        }}
        className="relative z-20 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted-foreground after:absolute after:-inset-2.5 after:content-[''] hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft"
      >
        <CircleHelp aria-hidden className="h-4 w-4" />
      </button>
      {open && entry ? (
        <span
          id={id}
          role="note"
          tabIndex={-1}
          ref={keepInViewport}
          className={`absolute left-0 z-20 w-64 max-w-[80vw] rounded-lg border border-border bg-white p-3 text-left text-xs font-normal normal-case leading-relaxed tracking-normal text-foreground shadow-lg ${
            placement === "top" ? "bottom-full mb-1" : "top-full mt-1"
          }`}
        >
          <span className="block">{entry.definition}</span>
          <Link
            href={guideHref(entry)}
            className="mt-2 inline-block font-semibold text-gold-text underline underline-offset-4"
          >
            En savoir plus
          </Link>
        </span>
      ) : null}
    </span>
  );
}
