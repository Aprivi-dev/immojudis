import { parisDateKey } from "@/lib/sale-countdown";
import { stateListingStatus } from "@/lib/property-characteristics";
import { getDisplaySurface } from "@/lib/surface";
import type { AuctionSale } from "@/lib/types";

/**
 * Pastille « N points à vérifier » des cartes de vente (liste `/sales`, favoris).
 *
 * Rien n'est calculé ici qui ne soit déjà sur la carte : chaque point est un fait que la carte
 * montre ou que l'annonce signale elle-même (« Surface n.c. », « À confirmer », une procédure sur
 * laquelle les sources ne s'accordent pas). Le palier de complétude (`completeness_tier`) n'est
 * pas compté : il dit qu'une annonce est bien renseignée, jamais ce qui lui manque (le score et ses
 * entrées ne sortent pas de la base).
 *
 * Quand la donnée n'est pas fiable, il n'y a pas de pastille :
 * - un champ absent de la ligne (colonne non lue pour ce compte, aperçu public) n'est jamais compté
 *   comme manquant : seul un champ lu et vide l'est ;
 * - l'occupation n'est comptée que si la carte la montre (`occupancyVisible`) ;
 * - une cession de l'État sans date n'a pas de « date à confirmer » : c'est son fonctionnement ;
 * - une vente passée, retirée ou annulée n'a plus rien à vérifier avant l'audience.
 */
export type PointToVerify = {
  key: "surface" | "occupancy" | "date" | "procedure";
  label: string;
};

const CLOSED_STATUSES = new Set(["past", "adjudicated", "cancelled", "withdrawn", "quarantined"]);

/** Occupation sans information : les valeurs que `occupancyLabel` affiche « Non renseigné » / « À confirmer ». */
function occupancyUnknown(status: string | null | undefined): boolean {
  if (!status) return true;
  const value = status.trim().toLowerCase();
  return value === "" || value === "unknown" || value === "inconnu";
}

function isPast(saleDate: string, now: Date): boolean {
  const date = new Date(saleDate);
  return Number.isFinite(date.getTime()) && parisDateKey(date) < parisDateKey(now);
}

export function pointsToVerify(
  sale: AuctionSale,
  options: { occupancyVisible: boolean; now?: Date },
): PointToVerify[] {
  const now = options.now ?? new Date();
  if (CLOSED_STATUSES.has((sale.status ?? "").toLowerCase())) return [];
  if (sale.sale_date && isPast(sale.sale_date, now)) return [];

  const points: PointToVerify[] = [];
  if (sale.app_surface_m2 !== undefined && getDisplaySurface(sale).value == null) {
    points.push({ key: "surface", label: "Surface non communiquée dans l’annonce" });
  }
  if (
    options.occupancyVisible &&
    sale.occupancy_status !== undefined &&
    occupancyUnknown(sale.occupancy_status)
  ) {
    points.push({ key: "occupancy", label: "Occupation du bien à confirmer" });
  }
  if (
    sale.sale_date !== undefined &&
    !(sale.sale_date && Number.isFinite(new Date(sale.sale_date).getTime())) &&
    !stateListingStatus(sale)
  ) {
    points.push({ key: "date", label: "Date de la vente à confirmer" });
  }
  if (sale.sale_verification_status === "conflict") {
    points.push({ key: "procedure", label: "Type de vente à confirmer (sources en désaccord)" });
  }
  return points;
}

/** « 1 point à vérifier », « 3 points à vérifier ». */
export function pointsToVerifyLabel(count: number): string {
  return `${count} point${count > 1 ? "s" : ""} à vérifier`;
}
