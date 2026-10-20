/**
 * Santé publique du site (`/api/health`), lue par une sonde externe et par le test de fumée
 * (`scripts/check-production-smoke.mjs`). Module de calcul pur : seuils et verdict. La lecture de la
 * base est dans la route.
 *
 * La réponse ne dit que deux choses, sans rien de sensible (ni nom d'alerte, ni message d'erreur, ni
 * identifiant) :
 * - l'âge du dernier succès de la tâche `operational-health` (Supabase `pg_cron`, toutes les 15 min) :
 *   c'est elle qui évalue toutes les alertes, donc si elle ne passe plus personne n'est averti ;
 * - l'âge de la dernière collecte réussie d'une source (`last_publication_complete_at`).
 */
export const HEALTH_OPERATIONAL_MAX_AGE_MINUTES = 45;
export const HEALTH_COLLECTION_MAX_AGE_HOURS = 18;

export type HealthStatus = "ok" | "degraded";

export type HealthReport = {
  status: HealthStatus;
  checkedAt: string;
  /** Âge du dernier succès de `operational-health`, en minutes ; `null` si aucun ou illisible. */
  operationalHealth: { ageMinutes: number | null; maxMinutes: number; ok: boolean };
  /** Âge de la dernière collecte réussie, en heures (une décimale) ; `null` si aucune. */
  collection: { ageHours: number | null; maxHours: number; ok: boolean };
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
  lastCollectionAt,
}: {
  now: Date;
  lastOperationalHealthSuccessAt: string | null | undefined;
  lastCollectionAt: string | null | undefined;
}): HealthReport {
  const healthAge = ageMs(lastOperationalHealthSuccessAt, now);
  const collectionAge = ageMs(lastCollectionAt, now);
  const operationalOk =
    healthAge !== null && healthAge <= HEALTH_OPERATIONAL_MAX_AGE_MINUTES * 60_000;
  const collectionOk =
    collectionAge !== null && collectionAge <= HEALTH_COLLECTION_MAX_AGE_HOURS * 3_600_000;
  return {
    status: operationalOk && collectionOk ? "ok" : "degraded",
    checkedAt: now.toISOString(),
    operationalHealth: {
      ageMinutes: healthAge === null ? null : Math.floor(healthAge / 60_000),
      maxMinutes: HEALTH_OPERATIONAL_MAX_AGE_MINUTES,
      ok: operationalOk,
    },
    collection: {
      ageHours: collectionAge === null ? null : Math.round(collectionAge / 360_000) / 10,
      maxHours: HEALTH_COLLECTION_MAX_AGE_HOURS,
      ok: collectionOk,
    },
  };
}

/** Réponse quand la base ne répond pas : dégradé, sans rien d'autre à dire. */
export function unavailableHealthReport(now: Date): HealthReport {
  return buildHealthReport({
    now,
    lastOperationalHealthSuccessAt: null,
    lastCollectionAt: null,
  });
}
