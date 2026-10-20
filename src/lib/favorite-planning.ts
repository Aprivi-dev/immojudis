import type { FavoriteSale } from "@/lib/favorites";
import { calendarDaysBetween, parisDateKey } from "@/lib/sale-countdown";
import { saleIsTribunalVenue } from "@/lib/sale-procedure";
import { saleHearingTime } from "@/lib/seo";

/**
 * « Mon planning » (`/favoris`) : les ventes suivies rangées par prochaine audience.
 *
 * Seules les dates sourcées y figurent : une vente reportée, en conflit de sources, dont la date a été
 * écartée par la relecture ou qui n'en a pas est mise à part, sans date ni « à confirmer » inventé.
 * Le fichier `.ics` est refait côté serveur avec la règle de l'export d'une seule audience
 * (`get_public_sale_calendar_event`) : ce tri n'en est que la liste de départ.
 */

/** Ventes envoyées à l'export : le plafond du fichier, aussi celui de la mesure quotidienne d'un compte. */
export const PLANNING_CALENDAR_MAX_SALES = 50;

export type PlanningEntry = {
  favorite: FavoriteSale;
  /** Jour de l'audience (Europe/Paris), `AAAA-MM-JJ`. */
  dayKey: string;
  /** Jours restants : 0 le jour même. */
  daysUntil: number;
  /** Heure de début, `10 h 00`, quand l'annonce la donne ; jamais devinée. */
  time: string | null;
};

export type Planning = {
  /** Audiences à venir, de la plus proche à la plus lointaine. */
  dated: PlanningEntry[];
  /** Ventes suivies sans audience datée à retenir (sans date, reportée, contredite, écartée). */
  undated: FavoriteSale[];
};

/** Statuts dont la date d'audience compte : `postponed`, `withdrawn`… gardent une date périmée. */
const DATED_STATUSES: ReadonlySet<string> = new Set(["upcoming", "unknown"]);

export function buildPlanning({
  favorites,
  now,
  dateBlocked = () => false,
}: {
  favorites: readonly FavoriteSale[];
  now: Date;
  /** Vrai quand la relecture de la fiche écarte la date de cette vente. */
  dateBlocked?: (saleId: string) => boolean;
}): Planning {
  const today = parisDateKey(now);
  const dated: PlanningEntry[] = [];
  const undated: FavoriteSale[] = [];

  for (const favorite of favorites) {
    const { sale } = favorite;
    const date = sale.sale_date ? new Date(sale.sale_date) : null;
    const reliable =
      date != null &&
      Number.isFinite(date.getTime()) &&
      DATED_STATUSES.has(sale.status ?? "unknown") &&
      sale.sale_verification_status !== "conflict" &&
      !dateBlocked(favorite.saleId);
    if (!reliable) {
      undated.push(favorite);
      continue;
    }
    const dayKey = parisDateKey(date);
    const daysUntil = calendarDaysBetween(today, dayKey);
    // Une audience passée n'est pas « sans date » : les ventes passées ont leur propre section.
    if (daysUntil == null || daysUntil < 0) continue;
    dated.push({ favorite, dayKey, daysUntil, time: saleHearingTime(sale.sale_date) });
  }

  dated.sort(
    (a, b) =>
      Date.parse(a.favorite.sale.sale_date ?? "") - Date.parse(b.favorite.sale.sale_date ?? "") ||
      a.favorite.saleId.localeCompare(b.favorite.saleId),
  );
  return { dated, undated };
}

/** « J-3 », ou « Aujourd'hui » le jour même. */
export function planningDaysLabel(daysUntil: number): string {
  return daysUntil <= 0 ? "Aujourd’hui" : `J-${daysUntil}`;
}

/**
 * Ventes à envoyer à l'export `.ics` : les audiences au tribunal (les seules que le serveur exporte)
 * les plus proches, au plus `PLANNING_CALENDAR_MAX_SALES`.
 */
export function planningCalendarSaleIds(dated: readonly PlanningEntry[]): {
  saleIds: string[];
  truncated: boolean;
} {
  const tribunal = dated.filter((entry) => saleIsTribunalVenue(entry.favorite.sale));
  return {
    saleIds: tribunal.slice(0, PLANNING_CALENDAR_MAX_SALES).map((entry) => entry.favorite.saleId),
    truncated: tribunal.length > PLANNING_CALENDAR_MAX_SALES,
  };
}
