import type { CeilingConfidence } from "@/lib/bid-ceiling-engine";
import { formatPrice } from "@/lib/format";
import { occupancyClass, occupancyDetail } from "@/lib/occupancy-status";
import type { SaleRisk } from "@/lib/types";

/**
 * « La vente en une phrase » : ce que la fiche sait déjà, dit d'un trait en tête de page. Module
 * pur, par gabarits fixes : l'occupation, la place du plafond calculé par rapport au prix de départ,
 * puis le point à lever en premier (ou, à défaut, la fiabilité de l'estimation). Un constat, jamais
 * un conseil d'achat ; rien sur les occupants au-delà du statut d'occupation.
 */

/** Gravité à partir de laquelle un risque est « prioritaire » sur la fiche (`ListingChecks`). */
const PRIORITY_RISK_SEVERITY = 4;

/** Sous cette part du prix de départ, le plafond le dépasse « à peine » (comme `describeCeilingStartGap`). */
const NARROW_MARGIN_RATIO = 0.05;

function occupancyPart(status: string | null | undefined): string {
  switch (occupancyClass(status)) {
    case "vacant":
      return "Bien annoncé libre";
    case "rented":
      return "Bien loué";
    case "occupied":
      return occupancyDetail(status) === "squatted"
        ? "Bien occupé sans droit ni titre"
        : "Bien occupé";
    default:
      return "Occupation à confirmer";
  }
}

function pricePart(
  gap: number,
  startingPrice: number,
  ceilingTerm: string,
  referencePriceTerm: string,
): string {
  if (gap < 0) return `${ceilingTerm} calculée sous la ${referencePriceTerm}`;
  if (gap < startingPrice * NARROW_MARGIN_RATIO) {
    return `${ceilingTerm} calculée à peine au-dessus de la ${referencePriceTerm}`;
  }
  return `${ceilingTerm} calculée ${formatPrice(gap)} au-dessus de la ${referencePriceTerm}`;
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLocaleLowerCase("fr-FR") + text.slice(1);
}

function lastPart(
  risks: readonly SaleRisk[] | null | undefined,
  confidence: CeilingConfidence["label"] | null,
): string | null {
  const top = [...(risks ?? [])]
    .filter((risk) => (risk.severity ?? 0) >= PRIORITY_RISK_SEVERITY && risk.risk_label.trim())
    .sort((a, b) => (b.severity ?? 0) - (a.severity ?? 0))[0];
  if (top) return `à lever en priorité : ${lowerFirst(top.risk_label.trim())}`;
  if (confidence === "À consolider") return "estimation à consolider";
  if (confidence === "Indicatif") return "estimation indicative";
  return null;
}

/** `null` sans plafond chiffré à comparer au prix de départ : la phrase n'aurait pas d'objet. */
export function saleVerdict({
  occupancyStatus,
  startingPrice,
  startingPriceGap,
  ceilingTerm = "enchère plafond",
  referencePriceTerm = "mise à prix",
  risks,
  confidence,
}: {
  occupancyStatus: string | null | undefined;
  startingPrice: number | null | undefined;
  /** Plafond moins prix de départ (`startingPriceGap` du moteur) ; `null` : plafond non chiffré. */
  startingPriceGap: number | null | undefined;
  /** Les mots du régime de la vente, tous deux féminins (« offre plafond », « première offre possible »). */
  ceilingTerm?: string;
  referencePriceTerm?: string;
  risks?: readonly SaleRisk[] | null;
  confidence: CeilingConfidence["label"] | null;
}): string | null {
  if (startingPriceGap == null || startingPrice == null || !(startingPrice > 0)) return null;
  return `${[
    occupancyPart(occupancyStatus),
    pricePart(startingPriceGap, startingPrice, ceilingTerm, referencePriceTerm),
    lastPart(risks, confidence),
  ]
    .filter(Boolean)
    .join(" ; ")}.`;
}
