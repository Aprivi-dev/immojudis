import { dedupeHearings, type PublicHearing } from "@/lib/upcoming-hearings";

/**
 * « Les ventes de la même audience » : les autres ventes du même tribunal, le même jour, pour passer
 * de l'une à l'autre depuis une fiche. Module pur, calculé à partir des audiences publiques
 * (`get_public_upcoming_hearings`) : commune, type de bien, heure et mise à prix seulement, jamais
 * d'adresse. Une vente hors de cette liste (audience à plus de 30 jours, date non sourcée, vente
 * hors tribunal) n'a pas de bandeau.
 */
export type SaleHearingEntry = {
  id: string;
  propertyType: string | null;
  city: string | null;
  time: string | null;
  startingPriceEur: number | null;
};

export type SaleHearing = {
  /** Jour de l'audience à Paris (`AAAA-MM-JJ`). */
  dayKey: string;
  tribunalLabel: string;
  tribunalCode: string | null;
  /** Les ventes de l'audience, dans l'ordre de passage connu (heure, puis identifiant). */
  sales: SaleHearingEntry[];
  /** Position de la vente consultée dans `sales`. */
  index: number;
};

function sameSale(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** `null` quand la vente n'est pas dans la liste, ou seule à son audience. */
export function saleHearing(
  hearings: readonly PublicHearing[],
  saleId: string,
): SaleHearing | null {
  const current = hearings.find((hearing) => sameSale(hearing.id, saleId));
  if (!current) return null;
  const sameDay = hearings.filter(
    (hearing) => hearing.tribunalKey === current.tribunalKey && hearing.dayKey === current.dayKey,
  );
  // Une vente publiée deux fois ne compte qu'une fois ; si le doublon gardé n'est pas la vente
  // consultée, elle prend sa place (la fiche ouverte doit se retrouver dans sa propre audience).
  const kept = dedupeHearings(sameDay).map((hearing) =>
    !sameSale(hearing.id, current.id) &&
    current.sourceGroup != null &&
    hearing.sourceGroup === current.sourceGroup
      ? current
      : hearing,
  );
  const index = kept.findIndex((hearing) => sameSale(hearing.id, current.id));
  if (index < 0 || kept.length < 2) return null;
  return {
    dayKey: current.dayKey,
    tribunalLabel: current.tribunalLabel,
    tribunalCode: current.tribunalCode,
    sales: kept.map((hearing) => ({
      id: hearing.id.toLowerCase(),
      propertyType: hearing.propertyType,
      city: hearing.city,
      time: hearing.time,
      startingPriceEur: hearing.startingPriceEur,
    })),
    index,
  };
}
