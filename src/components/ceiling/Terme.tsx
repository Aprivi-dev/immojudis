"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import CircleHelp from "lucide-react/dist/esm/icons/circle-help.js";

/**
 * Définitions courtes et neutres, alignées sur le lexique du guide. Elles n'énoncent pas de règle
 * de procédure, sauf le montant de la garantie pour enchérir en saisie immobilière : les autres
 * montants, délais et conditions exacts relèvent du cahier des conditions de vente et de l'avocat.
 */
const TERMES: Record<TermeKey, TermeEntry> = {
  "mise-a-prix": {
    label: "mise à prix",
    definition:
      "Prix de départ de la vente aux enchères. Elle ne doit pas être confondue avec la valeur réelle du bien.",
    anchor: "lexique-mise-a-prix",
  },
  adjudication: {
    label: "adjudication",
    definition: "Attribution du bien au meilleur enchérisseur à l’issue de l’audience.",
    anchor: "lexique-adjudication",
  },
  surenchere: {
    label: "surenchère",
    definition:
      "Offre formée après une adjudication, dans les conditions et délais prévus par la loi, entraînant une nouvelle audience.",
    anchor: "lexique-surenchere",
  },
  consignation: {
    label: "consignation du prix",
    definition:
      "Dépôt du prix de l’adjudication sur un compte séquestre ou à la Caisse des dépôts et consignations, après la vente. À ne pas confondre avec la garantie remise avant d’enchérir.",
    anchor: "lexique-consignation-du-prix",
  },
  "enchere-plafond": {
    label: "enchère plafond",
    definition:
      "Montant maximum à ne pas dépasser, simulé à partir du marché, des frais, des travaux et des risques. C’est une aide à la décision, pas un conseil d’achat.",
    anchor: "lexique-enchere-plafond",
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
    anchor: "lexique-portage",
  },
  emoluments: {
    label: "émoluments",
    definition:
      "Rémunération de l’avocat qui conduit la vente, calculée selon un barème réglementé et payée en plus du prix.",
    anchor: "lexique-emoluments",
  },
  "garantie-encherir": {
    label: "garantie pour enchérir",
    definition:
      "Chèque de banque ou caution bancaire irrévocable remis à l’avocat avant les enchères (en saisie immobilière : 10 % de la mise à prix, 3 000 € au minimum). Elle est restituée à l’enchérisseur qui ne l’emporte pas. Le plan de trésorerie l’appelle aussi « consignation » ; ne la confondez pas avec la consignation du prix, versée après la vente.",
    anchor: "lexique-garantie-pour-encherir",
  },
  "frais-prealables": {
    label: "frais préalables",
    definition:
      "Frais de la procédure de saisie dont le montant a été fixé (taxé) par le juge. Ils sont à la charge de l’adjudicataire, en plus du prix. Leur montant est indiqué dans le cahier des conditions de vente ou annoncé avant les enchères : demandez-le à l’avocat poursuivant.",
  },
  "proces-verbal-descriptif": {
    label: "procès-verbal descriptif",
    definition:
      "Document dressé par un commissaire de justice qui décrit le bien : composition, état apparent et occupation constatés lors de sa visite.",
  },
  "cahier-conditions-vente": {
    label: "cahier des conditions de vente",
    definition:
      "Document juridique rédigé par l’avocat du créancier poursuivant, qui décrit le bien, les règles de la vente, l’occupation, les diagnostics, les servitudes et les frais. Il se consulte au greffe ou auprès de l’avocat poursuivant.",
    anchor: "lexique-cahier-des-conditions-de-vente",
  },
  "droit-preemption": {
    label: "droit de préemption",
    definition:
      "Droit, pour la commune ou un autre titulaire prévu par la loi, de se substituer à l’adjudicataire pour acquérir le bien, dans un délai fixé par la loi.",
  },
};

type TermeEntry = {
  label: string;
  definition: string;
  /** Ancre de l'entrée dans le lexique du guide (`lexique-<terme>`) ; sans elle, le lexique entier. */
  anchor?: string;
};

export type TermeKey =
  | "mise-a-prix"
  | "adjudication"
  | "surenchere"
  | "consignation"
  | "enchere-plafond"
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
  return `${GUIDE_PATH}#${entry.anchor ?? "lexique"}`;
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
  const entry: TermeEntry = TERMES[terme];

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
      {bare ? null : <span>{children ?? entry.label}</span>}
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        aria-controls={id}
        aria-label={`Définition : ${entry.label}`}
        onClick={() => setOpen((current) => !current)}
        className="relative z-20 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted-foreground after:absolute after:-inset-2.5 after:content-[''] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
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
