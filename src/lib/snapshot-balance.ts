import { formatBidCeilingInput } from "@/lib/favorite-dossier-shared";
import { MAX_SIMULATOR_AMOUNT_EUR } from "@/lib/simulator-limits";

/**
 * Bilan personnel après adjudication (n° 94) : le prix final que la personne a noté sur une vente
 * passée, et son écart avec l'enchère plafond qu'elle avait enregistrée.
 *
 * Tout vient de ce que la personne a elle-même saisi. Rien n'est déduit, estimé ni comparé aux autres
 * comptes : une valeur absente reste absente, et un écart n'existe que si le prix final ET le plafond
 * sont présents. Ces chiffres décrivent le passé de la personne ; ils ne disent rien du prix qu'il
 * faudrait proposer pour une autre vente.
 */

/** Les statuts pour lesquels un prix final a un sens : la vente a eu lieu et son résultat est connu. */
export const FINAL_PRICE_STATUSES = ["won", "lost"] as const;

export function statusAllowsFinalPrice(status: string | null | undefined): boolean {
  return (FINAL_PRICE_STATUSES as readonly string[]).includes(status ?? "");
}

export type FinalPriceInputResult = { ok: true; value: number } | { ok: false; message: string };

/**
 * Lit le montant saisi dans le champ « Prix final » : espaces (dont insécables) et « € » ignorés,
 * virgule ou point décimal. Un point suivi de trois chiffres (« 185.000 ») est refusé plutôt que lu
 * 185 € : mieux vaut une erreur qu'un prix divisé par mille. Mêmes bornes que le serveur.
 */
export function parseFinalPriceInput(raw: string): FinalPriceInputResult {
  const cleaned = raw.replace(/[\s\u00a0\u202f€]/g, "").replace(",", ".");
  if (cleaned === "") {
    return { ok: false, message: "Saisissez un montant en euros, par exemple 185 000." };
  }
  if (!/^\d+(?:\.\d{1,2})?$/.test(cleaned)) {
    return {
      ok: false,
      message: "Saisissez un montant en euros, en chiffres seulement, par exemple 185 000.",
    };
  }
  const value = Math.round(Number(cleaned));
  if (value < 1) return { ok: false, message: "Le prix final doit être supérieur à 0 €." };
  if (value > MAX_SIMULATOR_AMOUNT_EUR) {
    return {
      ok: false,
      message: `Le montant ne peut pas dépasser ${formatBidCeilingInput(MAX_SIMULATOR_AMOUNT_EUR)} €.`,
    };
  }
  return { ok: true, value };
}

export type CeilingGap = {
  /** Prix final moins plafond, en euros : négatif sous le plafond, positif au-dessus. */
  eur: number;
  /** Même écart en pourcentage du plafond (arrondi à l'unité). */
  pct: number;
};

/** L'écart entre le prix final et le plafond, ou `null` quand l'un des deux manque. */
export function gapWithCeiling(
  finalPriceEur: number | null | undefined,
  ceilingEur: number | null | undefined,
): CeilingGap | null {
  if (typeof finalPriceEur !== "number" || !Number.isFinite(finalPriceEur) || finalPriceEur <= 0) {
    return null;
  }
  if (typeof ceilingEur !== "number" || !Number.isFinite(ceilingEur) || ceilingEur <= 0) {
    return null;
  }
  const eur = Math.round(finalPriceEur - ceilingEur);
  return { eur, pct: Math.round((eur / ceilingEur) * 100) };
}

export type BalanceEntry = {
  personalStatus: string | null;
  bidCeilingEur: number | null;
  finalPriceEur: number | null;
};

export type BalanceGroup = {
  /** Ventes marquées ainsi, avec ou sans prix final. */
  count: number;
  /** Parmi elles, celles qui ont un prix final ET un plafond : les seules comparées. */
  compared: number;
  /**
   * Écart moyen, en pourcentage du plafond de chaque vente, sur les ventes comparées ; `null` s'il n'y
   * en a aucune. Les plafonds diffèrent d'une vente à l'autre : on ne moyenne pas des euros.
   */
  averageGapPct: number | null;
  /** Combien de ventes comparées ont un prix final au-dessus de leur plafond. */
  aboveCeiling: number;
};

export type SnapshotBalance = { won: BalanceGroup; lost: BalanceGroup };

function groupOf(entries: readonly BalanceEntry[]): BalanceGroup {
  const gaps = entries
    .map((entry) => gapWithCeiling(entry.finalPriceEur, entry.bidCeilingEur))
    .filter((gap): gap is CeilingGap => gap !== null);
  const average = (values: number[]) =>
    values.reduce((total, value) => total + value, 0) / values.length;
  return {
    count: entries.length,
    compared: gaps.length,
    averageGapPct: gaps.length ? Math.round(average(gaps.map((gap) => gap.pct))) : null,
    aboveCeiling: gaps.filter((gap) => gap.eur > 0).length,
  };
}

/** Les petites statistiques de la personne : ventes remportées et non remportées, écart moyen avec son plafond. */
export function buildSnapshotBalance(entries: readonly BalanceEntry[]): SnapshotBalance {
  return {
    won: groupOf(entries.filter((entry) => entry.personalStatus === "won")),
    lost: groupOf(entries.filter((entry) => entry.personalStatus === "lost")),
  };
}
