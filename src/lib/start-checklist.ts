/**
 * « Mon démarrage » : trois gestes guidés pour un compte connecté (suivre une vente, noter son statut
 * ou son enchère plafond, recevoir un rappel d'audience), détectés depuis les données existantes
 * (`user_favorites`, consentement `sale_reminders_enabled`), sans nouvelle table.
 */

/** Lignes de `user_favorites` lues pour le démarrage (les 100 plus récentes suffisent à le constater). */
export const START_FAVORITES_LIMIT = 100;

export type StartFavoriteRow = {
  sale_id: string;
  personal_status: string | null;
  bid_ceiling_eur: number | null;
};

export type StartProgress = {
  /** Au moins un favori. */
  followed: boolean;
  /** Au moins un « Mon dossier » rempli (un statut, ou une enchère plafond supérieure à 0 €). */
  dossierFilled: boolean;
  /** La vente où ouvrir « Mon dossier » : un favori dont le dossier est encore vide, sinon le premier. */
  dossierSaleId: string | null;
};

function dossierHasContent(row: StartFavoriteRow): boolean {
  // Un plafond de 0 € (ancienne saisie) compte comme absent, comme dans « Mon dossier ».
  return row.personal_status != null || (row.bid_ceiling_eur != null && row.bid_ceiling_eur > 0);
}

export function startProgress(rows: readonly StartFavoriteRow[]): StartProgress {
  const emptyDossier = rows.find((row) => !dossierHasContent(row));
  return {
    followed: rows.length > 0,
    dossierFilled: rows.some(dossierHasContent),
    dossierSaleId: (emptyDossier ?? rows[0])?.sale_id ?? null,
  };
}

export type StartStepId = "follow" | "dossier" | "reminder";

export type StartStep = { id: StartStepId; done: boolean };

/**
 * Les lignes affichées. Le rappel d'audience n'est proposé que si l'envoi est ouvert (voir
 * `SaleRemindersToggle`) ; une personne qui a déjà consenti garde la ligne, cochée.
 */
export function startSteps(
  progress: StartProgress,
  reminders: { available: boolean; enabled: boolean },
): StartStep[] {
  const steps: StartStep[] = [
    { id: "follow", done: progress.followed },
    { id: "dossier", done: progress.dossierFilled },
  ];
  if (reminders.available || reminders.enabled) {
    steps.push({ id: "reminder", done: reminders.enabled });
  }
  return steps;
}

export function startComplete(steps: readonly StartStep[]): boolean {
  return steps.every((step) => step.done);
}

/** Fermeture de la carte, mémorisée par compte dans le navigateur (`localStorage`). */
export function startCardClosedKey(userId: string): string {
  return `immojudis:mon-demarrage-ferme:v1:${userId}`;
}

export function readStartCardClosed(userId: string): boolean {
  try {
    return window.localStorage.getItem(startCardClosedKey(userId)) === "1";
  } catch {
    // Stockage inaccessible : la carte reste proposée.
    return false;
  }
}

export function writeStartCardClosed(userId: string): void {
  try {
    window.localStorage.setItem(startCardClosedKey(userId), "1");
  } catch {
    // Stockage inaccessible : la fermeture ne vaut que pour la page affichée.
  }
}
