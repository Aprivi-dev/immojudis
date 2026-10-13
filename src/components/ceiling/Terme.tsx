"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import CircleHelp from "lucide-react/dist/esm/icons/circle-help.js";

/**
 * Définitions courtes et neutres, alignées sur le lexique du guide. Elles n'énoncent aucune règle
 * de procédure : les montants, délais et conditions exacts relèvent du cahier des conditions de
 * vente et de l'avocat.
 */
const TERMES = {
  "mise-a-prix": {
    label: "mise à prix",
    definition:
      "Prix de départ de la vente aux enchères. Elle ne doit pas être confondue avec la valeur réelle du bien.",
  },
  adjudication: {
    label: "adjudication",
    definition: "Attribution du bien au meilleur enchérisseur à l’issue de l’audience.",
  },
  surenchere: {
    label: "surenchère",
    definition:
      "Offre formée après une adjudication, dans les conditions et délais prévus par la loi, entraînant une nouvelle audience.",
  },
  liberation: {
    label: "libération du bien",
    definition:
      "Fait de faire quitter les lieux à un occupant pour pouvoir disposer du bien. Elle prend du temps et peut avoir un coût.",
  },
  portage: {
    label: "portage",
    definition:
      "Ce que coûte le bien entre l’adjudication et le moment où vous l’habitez, le louez ou le revendez : charges, taxe foncière, assurance et coût de l’argent.",
  },
  emoluments: {
    label: "émoluments",
    definition:
      "Rémunération de l’avocat qui conduit la vente, calculée selon un barème réglementé et payée en plus du prix.",
  },
} as const;

export type TermeKey = keyof typeof TERMES;

const GUIDE_HREF = "/ventes-immobilieres-judiciaires#lexique";

/**
 * Un mot du métier suivi d'une petite bulle d'aide : un bouton qui ouvre une définition courte et
 * un lien vers le guide. Fermeture à la touche Échap, au clic extérieur ou quand le focus sort.
 */
export function Terme({ terme, children }: { terme: TermeKey; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const entry = TERMES[terme];

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
      <span>{children ?? entry.label}</span>
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={`Définition : ${entry.label}`}
        onClick={() => setOpen((current) => !current)}
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
      >
        <CircleHelp aria-hidden className="h-4 w-4" />
      </button>
      {open ? (
        <span
          id={id}
          role="note"
          tabIndex={-1}
          className="absolute left-0 top-full z-20 mt-1 w-64 max-w-[80vw] rounded-lg border border-border bg-white p-3 text-left text-xs font-normal normal-case leading-relaxed tracking-normal text-foreground shadow-lg"
        >
          <span className="block">{entry.definition}</span>
          <Link
            href={GUIDE_HREF}
            className="mt-2 inline-block font-semibold text-gold-text underline underline-offset-4"
          >
            En savoir plus
          </Link>
        </span>
      ) : null}
    </span>
  );
}
