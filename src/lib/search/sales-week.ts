import { addDays } from "@/lib/calendar-day";
import { hasClientOnlyFilters } from "./search-filters";
import type { SalesSearchParams } from "./search-url-state";

/**
 * « dont M cette semaine » du titre de /sales : les ventes de la recherche courante dont la date
 * tombe dans les sept prochains jours, aujourd'hui compris (jours calendaires de Paris, comme le
 * compte à rebours des cartes et la pastille « Dans 7 jours »).
 *
 * Le nombre vient d'un comptage de la même recherche, bornée à ces dates (`minSaleDate`,
 * `maxSaleDate`) : une seule requête de comptage, sans liste. Il n'est pas demandé quand la
 * recherche porte un filtre lu sur les lignes (pépites, sous la fourchette, points à vérifier…) :
 * ces filtres font lire toute la recherche, et la relire bornée aux dates coûterait un second
 * balayage complet. Le titre n'affiche alors que le total.
 */
const UPCOMING_WEEK_DAYS = 7;

export type UpcomingWeekScope =
  /** Recherche à compter : celle de la page, bornée aux sept prochains jours (sans page ni tri). */
  | { kind: "count"; search: SalesSearchParams }
  /** Les dates choisies par la personne ne recoupent pas la semaine : zéro, sans requête. */
  | { kind: "none" }
  /** Comptage trop coûteux pour cette recherche (filtres lus sur les lignes) : on ne l'affiche pas. */
  | { kind: "unavailable" };

/**
 * La recherche à compter pour « cette semaine », à partir de la recherche affichée et du jour
 * (`today`, jour de Paris au format AAAA-MM-JJ : `parisDateKey`). Les dates choisies par la personne sont croisées
 * avec la semaine : « du 1er au 3 » reste « du 1er au 3 » si ces jours sont dans la semaine.
 */
export function upcomingWeekScope(search: SalesSearchParams, today: string): UpcomingWeekScope {
  if (hasClientOnlyFilters(search)) return { kind: "unavailable" };
  const weekEnd = addDays(today, UPCOMING_WEEK_DAYS - 1);
  const from = search.minSaleDate && search.minSaleDate > today ? search.minSaleDate : today;
  const to = search.maxSaleDate && search.maxSaleDate < weekEnd ? search.maxSaleDate : weekEnd;
  if (from > to) return { kind: "none" };
  return {
    kind: "count",
    search: {
      ...search,
      minSaleDate: from,
      maxSaleDate: to,
      // Le total ne dépend ni de la page, ni du tri, ni de l'affichage de la carte : sans eux, le
      // même comptage sert à toutes les pages de la recherche.
      page: undefined,
      limit: undefined,
      sort: undefined,
      map: undefined,
    },
  };
}
