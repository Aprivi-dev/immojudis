import { z } from "zod";

/**
 * Validateur d'adresse email unique de l'agent d'information, partagé par le serveur, l'interface
 * d'administration et les schémas de requête. L'agent ne fonctionne que par email : un numéro de
 * téléphone, un nom ou un champ vide n'est jamais un destinataire.
 *
 * Miroir SQL : `app_private.information_agent_email_is_valid` (migration 20261108203000), identique
 * à ce que `z.string().email()` accepte ; miroir Python : `_ZOD_EMAIL_RE` dans
 * `services/data-pipeline/src/information_sufficiency.py`.
 */

/** Motif donné quand aucune adresse email valide n'existe pour une vente ou un destinataire. */
export const INFORMATION_AGENT_NO_EMAIL_MESSAGE =
  "Aucune adresse email de contact : l'agent ne peut pas écrire.";

/**
 * Motif du refus de brouillon quand aucun destinataire n'est retenu, selon le nombre de contacts
 * candidats (sans email, l'agent ne peut pas écrire). La création est analysée par la route avec le
 * même validateur : une saisie qui n'est pas une adresse n'arrive jamais jusqu'ici.
 */
export function missingRecipientMessage(candidateCount: number, noAddressNote: string): string {
  if (candidateCount > 1) {
    return "Requête invalide : plusieurs contacts sont possibles. Choisissez explicitement l'adresse email du professionnel à contacter.";
  }
  if (candidateCount === 1) {
    return `Requête invalide : renseignez l'adresse email du professionnel à contacter.${noAddressNote}`;
  }
  return `${INFORMATION_AGENT_NO_EMAIL_MESSAGE}${noAddressNote}`;
}

const emailSchema = z.string().email();

/** Adresse en minuscules, sans espaces autour ; null si la valeur n'est pas une adresse valide. */
export function normalizedEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return emailSchema.safeParse(normalized).success ? normalized : null;
}

export function isValidInformationAgentEmail(value: unknown): boolean {
  return normalizedEmail(value) !== null;
}
