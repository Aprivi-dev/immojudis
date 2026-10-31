import type { ReactElement } from "react";
import { cn } from "@/lib/utils";

/**
 * Illustration générique d'un type de bien, pour une annonce sans photo ni vue fiable (liste de
 * /sales). Un dessin sobre aux couleurs de la marque (traits marine, sol or, fond beige du parent),
 * jamais une image du bien : le dessin est le même pour tous les biens d'un même type, et la
 * personne qui lit est prévenue deux fois (pastille visible « Illustration » dans `SaleVisual`, et
 * nom accessible qui le dit). Règle : docs/design/fondations.md, « Annonce sans photo ».
 */
export type IllustrationKind = "house" | "apartment" | "building" | "land";

const KIND_LABELS: Record<IllustrationKind, string> = {
  house: "une maison",
  apartment: "un appartement",
  building: "un immeuble",
  land: "un terrain",
};

/**
 * Le dessin d'un type de bien (mêmes mots que `propertyTypeLabel`). Tout ce qui n'a pas son dessin
 * (garage, local commercial, bien mixte, type inconnu ou à qualifier) prend la maison, le repli
 * générique.
 */
export function illustrationKind(propertyType: string | null | undefined): IllustrationKind {
  const type = (propertyType ?? "").toLowerCase();
  if (type === "unknown" || type === "other" || type === "mixed" || type.includes("mixte")) {
    return "house";
  }
  if (type.includes("apart") || type.includes("apt") || type.includes("studio")) return "apartment";
  if (type.includes("building") || type.includes("immeuble")) return "building";
  if (type.includes("land") || type.includes("terrain")) return "land";
  return "house";
}

/** Nom accessible : ce que c'est, et que ce n'est pas le bien. */
function illustrationLabel(kind: IllustrationKind): string {
  return `Illustration générique de ${KIND_LABELS[kind]} : aucune photo du bien n’est disponible`;
}

const STROKE = "fill-none stroke-brand-navy [stroke-linecap:round] [stroke-linejoin:round]";

/** Fenêtre carrée aux traits marine, remplie de beige clair. */
function Window({ x, y, size = 9 }: { x: number; y: number; size?: number }) {
  return (
    <rect
      x={x}
      y={y}
      width={size}
      height={size}
      rx={1.5}
      className="fill-white stroke-brand-navy [stroke-width:2.5]"
    />
  );
}

function House() {
  return (
    <>
      <path d="M26 44 60 16l34 28" className={STROKE} strokeWidth={5} />
      <path d="M33 40v31h54V40" className={STROKE} strokeWidth={5} />
      <path d="M78 27v-9h8v16" className={STROKE} strokeWidth={4} />
      <rect
        x={53}
        y={50}
        width={14}
        height={21}
        rx={2}
        className="fill-gold stroke-brand-navy [stroke-width:3]"
      />
      <Window x={38} y={48} />
      <Window x={73} y={48} />
    </>
  );
}

function Apartment() {
  return (
    <>
      <path d="M38 71V14h44v57" className={STROKE} strokeWidth={5} />
      <path d="M32 14h56" className={STROKE} strokeWidth={5} />
      {[22, 38, 54].map((y) => (
        <g key={y}>
          <Window x={44} y={y} size={8} />
          <Window x={68} y={y} size={8} />
        </g>
      ))}
      <rect
        x={54}
        y={56}
        width={12}
        height={15}
        rx={2}
        className="fill-gold stroke-brand-navy [stroke-width:3]"
      />
    </>
  );
}

function Building() {
  return (
    <>
      <path d="M18 71V30h32v41" className={STROKE} strokeWidth={5} />
      <path d="M56 71V14h46v57" className={STROKE} strokeWidth={5} />
      {[36, 52].map((y) => (
        <Window key={`l${y}`} x={27} y={y} size={8} />
      ))}
      {[22, 38, 54].map((y) => (
        <g key={y}>
          <Window x={62} y={y} size={8} />
          <Window x={84} y={y} size={8} />
        </g>
      ))}
      <rect
        x={71}
        y={58}
        width={11}
        height={13}
        rx={2}
        className="fill-gold stroke-brand-navy [stroke-width:3]"
      />
    </>
  );
}

function Land() {
  return (
    <>
      {/* Parcelle : un contour en pointillé, un arbre et une borne. */}
      <path
        d="M16 66 34 36h58l12 30Z"
        className="fill-none stroke-brand-navy [stroke-dasharray:2_7] [stroke-linecap:round] [stroke-linejoin:round]"
        strokeWidth={4}
      />
      <path d="M60 66V46" className={STROKE} strokeWidth={5} />
      <circle cx={60} cy={34} r={14} className="fill-white stroke-brand-navy [stroke-width:5]" />
      <path d="M90 62v-8" className={STROKE} strokeWidth={4} />
    </>
  );
}

const DRAWINGS: Record<IllustrationKind, () => ReactElement> = {
  house: House,
  apartment: Apartment,
  building: Building,
  land: Land,
};

export function PropertyIllustration({
  kind,
  className,
}: {
  kind: IllustrationKind;
  className?: string;
}) {
  const Drawing = DRAWINGS[kind];
  return (
    <svg
      viewBox="0 0 120 80"
      role="img"
      aria-label={illustrationLabel(kind)}
      data-illustration={kind}
      className={cn("h-full w-auto", className)}
    >
      <Drawing />
      {/* Le sol, en or : la signature de la marque. */}
      <path
        d="M8 76h104"
        className="fill-none stroke-gold [stroke-linecap:round]"
        strokeWidth={5}
      />
    </svg>
  );
}
