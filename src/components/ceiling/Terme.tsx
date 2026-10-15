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
  "garantie-encherir": {
    label: "garantie pour enchérir",
    definition:
      "Chèque de banque ou caution bancaire remis à l’avocat avant les enchères, restitué à l’enchérisseur qui ne l’emporte pas. Le plan de trésorerie l’appelle aussi « consignation » ; ne la confondez pas avec la consignation du prix, versée après la vente.",
  },
  "frais-prealables": {
    label: "frais préalables",
    definition:
      "Frais de la procédure dont le juge a fixé le montant (aussi appelés frais taxés). Ils sont annoncés avant l’ouverture des enchères et payés en plus du prix.",
  },
  "proces-verbal-descriptif": {
    label: "procès-verbal descriptif",
    definition:
      "Document dressé par un commissaire de justice qui décrit le bien : composition, état apparent et occupation constatés lors de sa visite.",
  },
  "cahier-conditions-vente": {
    label: "cahier des conditions de vente",
    definition:
      "Document juridique décrivant le bien, les règles de la vente, l’occupation, les diagnostics, les servitudes et les frais. Il se consulte au greffe ou auprès de l’avocat poursuivant.",
  },
  "droit-preemption": {
    label: "droit de préemption",
    definition:
      "Droit, pour la commune ou un autre titulaire prévu par la loi, de se substituer à l’adjudicataire pour acquérir le bien, dans un délai fixé par la loi.",
  },
} as const;

export type TermeKey = keyof typeof TERMES;

const GUIDE_HREF = "/ventes-immobilieres-judiciaires#lexique";

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
  placement = "bottom",
}: {
  terme: TermeKey;
  children?: ReactNode;
  /** `top` ouvre la bulle au-dessus du mot, pour un mot proche du bas d'un conteneur qui rogne. */
  placement?: "bottom" | "top";
}) {
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
        className="relative inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted-foreground after:absolute after:-inset-2.5 after:content-[''] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
      >
        <CircleHelp aria-hidden className="h-4 w-4" />
      </button>
      {open ? (
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
