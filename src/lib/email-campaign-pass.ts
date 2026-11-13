import { calendarDaysBetween } from "@/lib/calendar-day";
import { parisDateKey } from "@/lib/paris-time";

/**
 * Limites et boucle communes des passages d'envoi d'emails planifiés (rappels d'audience, alertes
 * de résultat, récapitulatif hebdomadaire, fin d'essai) : les routes de ces tâches ont 60 s.
 */

/** Marge sous les 60 s de la route : le passage s'arrête de lui-même, la suite au suivant. */
export const EMAIL_PASS_BUDGET_MS = 50_000;

/** Comptes traités en même temps dans un passage. */
export const EMAIL_PASS_USER_CONCURRENCY = 4;

/** Garde-fou : au-delà, le passage s'arrête là (les comptes suivants attendent le suivant). */
export const EMAIL_PASS_MAX_CONSENTING_USERS = 10_000;

/**
 * Traite les comptes dans l'ordre, `EMAIL_PASS_USER_CONCURRENCY` à la fois. Passé `deadline`
 * (horodatage en ms), aucun nouveau lot ne part : `truncated`, les comptes restants attendent le
 * passage suivant. Un compte en échec fait échouer le passage après son lot : une erreur de lecture
 * (base injoignable) n'est pas une absence d'envoi, le passage doit être vu et rejoué, et le journal
 * de chaque envoi empêche tout doublon.
 */
export async function runEmailPass(
  recipients: readonly string[],
  processUser: (userId: string) => Promise<void>,
  { deadline, name }: { deadline: number; name: string },
): Promise<{ truncated: boolean }> {
  for (let index = 0; index < recipients.length; index += EMAIL_PASS_USER_CONCURRENCY) {
    if (Date.now() > deadline) return { truncated: true };
    const batch = recipients.slice(index, index + EMAIL_PASS_USER_CONCURRENCY);
    const settled = await Promise.allSettled(batch.map((userId) => processUser(userId)));
    const failure = settled.find((result) => result.status === "rejected");
    if (failure && failure.status === "rejected") {
      throw failure.reason instanceof Error
        ? failure.reason
        : new Error(`${name}: user processing failed.`);
    }
  }
  return { truncated: false };
}

/** Lecture par vente faite une seule fois par passage (la date publique d'une vente suivie). */
export function readOncePerSale<T>(read: (saleId: string) => Promise<T>) {
  const cache = new Map<string, Promise<T>>();
  return (saleId: string): Promise<T> => {
    let cached = cache.get(saleId);
    if (!cached) {
      cached = read(saleId);
      cache.set(saleId, cached);
    }
    return cached;
  };
}

/**
 * Ventes suivies dont la date stockée tombe entre aujourd'hui et `maxDays` jours (jours de Paris),
 * les plus proches d'abord, `limit` au plus ; `truncated` quand il y en avait davantage. Une date
 * absente ou illisible écarte la vente.
 */
export function followedSalesInWindow<T extends { id: string; saleDate: string | null }>(
  sales: readonly T[],
  now: Date,
  { maxDays, limit }: { maxDays: number; limit: number },
): { sales: T[]; truncated: boolean } {
  const todayKey = parisDateKey(now);
  const inWindow: Array<{ sale: T; days: number }> = [];
  for (const sale of sales) {
    const stored = sale.saleDate ? new Date(sale.saleDate) : null;
    if (!stored || !Number.isFinite(stored.getTime())) continue;
    const days = calendarDaysBetween(todayKey, parisDateKey(stored));
    if (days == null || days < 0 || days > maxDays) continue;
    inWindow.push({ sale, days });
  }
  inWindow.sort((a, b) => a.days - b.days || a.sale.id.localeCompare(b.sale.id));
  return {
    sales: inWindow.slice(0, limit).map(({ sale }) => sale),
    truncated: inWindow.length > limit,
  };
}
