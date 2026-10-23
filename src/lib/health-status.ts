/**
 * Santé publique du site (`/api/health`), lue par une sonde externe et par le test de fumée
 * (`scripts/check-production-smoke.mjs`). Module de calcul pur : seuils et verdict. La lecture de la
 * base est dans la route.
 *
 * La réponse ne dit que deux choses, sans rien de sensible (ni nom d'alerte, ni nom de source, ni
 * message d'erreur, ni identifiant) :
 * - l'âge du dernier succès de la tâche `operational-health` (Supabase `pg_cron`, toutes les 15 min) :
 *   c'est elle qui évalue toutes les alertes, donc si elle ne passe plus personne n'est averti ;
 * - l'état de la collecte des sources ACTIVÉES (`auction_source_state.enabled`) : l'âge de la plus
 *   ancienne dernière publication complète (`last_publication_complete_at`), et le nombre de sources en
 *   retard. Le verdict ne se calcule pas sur la source la plus récente : une source figée n'est pas
 *   masquée par les autres. Une source activée qui n'a jamais de publication complète est en retard.
 */
export const HEALTH_OPERATIONAL_MAX_AGE_MINUTES = 45;
/**
 * Au-delà, une source activée est en retard. Plus large que l'alerte `pipeline.source.<source>.missed`
 * (18 h) : la sonde publique ne doit pas osciller sur un cycle de collecte un peu long.
 */
export const HEALTH_COLLECTION_MAX_AGE_HOURS = 36;
/** Durée de garde du CDN (`s-maxage`) : au plus une lecture de la base toutes les 30 s et par région. */
export const HEALTH_CACHE_SECONDS = 30;

export type HealthStatus = "ok" | "degraded";

export type HealthReport = {
  /**
   * La base répond : la disponibilité du site, séparée de la fraîcheur des données. `false` seulement
   * quand la route n'a pas pu lire la base (alors HTTP 503).
   */
  available: boolean;
  /** Fraîcheur : `degraded` quand une tâche ou une source est en retard (la route répond tout de même 200). */
  status: HealthStatus;
  checkedAt: string;
  /** Âge du dernier succès de `operational-health`, en minutes ; `null` si aucun ou illisible. */
  operationalHealth: { ageMinutes: number | null; maxMinutes: number; ok: boolean };
  /**
   * Sources activées. `ageHours` : âge (une décimale) de la plus ancienne dernière publication
   * complète connue, `null` si aucune n'est connue ; `enabledSources` : leur nombre ; `lateSources` :
   * celles dont la publication complète a plus de `maxHours` ou n'existe pas. `ok` : au moins une
   * source activée et aucune en retard.
   */
  collection: {
    ageHours: number | null;
    maxHours: number;
    ok: boolean;
    enabledSources: number;
    lateSources: number;
  };
};

function ageMs(value: string | null | undefined, now: Date): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  // Une horloge en avance ne rend pas la donnée « plus fraîche que maintenant ».
  return Math.max(0, now.getTime() - time);
}

export function buildHealthReport({
  now,
  lastOperationalHealthSuccessAt,
  enabledSourceCompletions,
}: {
  now: Date;
  lastOperationalHealthSuccessAt: string | null | undefined;
  /** Une entrée par source ACTIVÉE : sa dernière publication complète, `null` si elle n'en a jamais. */
  enabledSourceCompletions: ReadonlyArray<string | null | undefined>;
}): HealthReport {
  const healthAge = ageMs(lastOperationalHealthSuccessAt, now);
  const operationalOk =
    healthAge !== null && healthAge <= HEALTH_OPERATIONAL_MAX_AGE_MINUTES * 60_000;

  const maxCollectionMs = HEALTH_COLLECTION_MAX_AGE_HOURS * 3_600_000;
  const ages = enabledSourceCompletions.map((value) => ageMs(value, now));
  const knownAges = ages.filter((age): age is number => age !== null);
  const lateSources = ages.filter((age) => age === null || age > maxCollectionMs).length;
  const oldestAge = knownAges.length ? Math.max(...knownAges) : null;
  const collectionOk = ages.length > 0 && lateSources === 0;

  return {
    available: true,
    status: operationalOk && collectionOk ? "ok" : "degraded",
    checkedAt: now.toISOString(),
    operationalHealth: {
      ageMinutes: healthAge === null ? null : Math.floor(healthAge / 60_000),
      maxMinutes: HEALTH_OPERATIONAL_MAX_AGE_MINUTES,
      ok: operationalOk,
    },
    collection: {
      ageHours: oldestAge === null ? null : Math.round(oldestAge / 360_000) / 10,
      maxHours: HEALTH_COLLECTION_MAX_AGE_HOURS,
      ok: collectionOk,
      enabledSources: ages.length,
      lateSources,
    },
  };
}

/** Réponse quand la base ne répond pas : indisponible (HTTP 503), sans rien d'autre à dire. */
export function unavailableHealthReport(now: Date): HealthReport {
  return {
    ...buildHealthReport({
      now,
      lastOperationalHealthSuccessAt: null,
      enabledSourceCompletions: [],
    }),
    available: false,
  };
}
