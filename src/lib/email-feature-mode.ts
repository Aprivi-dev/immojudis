import { serverEnv, type EnvSource } from "@/lib/env";

/**
 * Interrupteurs d'envoi des deux emails ajoutés après les rappels d'audience : le récapitulatif
 * hebdomadaire « Ma semaine » (`WEEKLY_DIGEST_MODE`) et l'alerte de résultat ou de remise en vente
 * (`SALE_RESULTS_MODE`). Même règle que `SALE_REMINDERS_MODE` (`sale-reminders-mode.ts`) :
 *
 * - `off` (défaut, et toute valeur inconnue) : rien n'est envoyé, la case de consentement n'est
 *   pas proposée ;
 * - `internal` : seuls les administrateurs reçoivent les emails (et voient la case) ;
 * - `on` : toutes les personnes qui ont consenti.
 *
 * Un doute sur la valeur ferme l'envoi : une faute de frappe ne peut pas ouvrir l'envoi à tous. Le
 * propriétaire n'ouvre qu'après avoir mis à jour la politique de confidentialité et le registre des
 * traitements.
 */
export const EMAIL_FEATURE_MODES = ["off", "internal", "on"] as const;
export type EmailFeatureMode = (typeof EMAIL_FEATURE_MODES)[number];

type Env = Pick<NodeJS.ProcessEnv, string>;

function parseMode(value: string | undefined): EmailFeatureMode {
  const mode = value?.toLowerCase();
  return mode === "internal" || mode === "on" ? mode : "off";
}

/** Mode du récapitulatif hebdomadaire « Ma semaine » (`WEEKLY_DIGEST_MODE`). */
export function weeklyDigestMode(env: Env = process.env): EmailFeatureMode {
  return parseMode(serverEnv(env as EnvSource).weeklyDigest.mode);
}

/** Mode de l'alerte de résultat ou de remise en vente (`SALE_RESULTS_MODE`). */
export function saleResultsMode(env: Env = process.env): EmailFeatureMode {
  return parseMode(serverEnv(env as EnvSource).saleResults.mode);
}

function offeredTo(mode: EmailFeatureMode, isAdmin: boolean): boolean {
  return mode === "on" || (mode === "internal" && isAdmin);
}

/** La case « récapitulatif hebdomadaire » est-elle proposée à cette personne ? */
export function weeklyDigestOfferedTo({
  isAdmin,
  env = process.env,
}: {
  isAdmin: boolean;
  env?: Env;
}): boolean {
  return offeredTo(weeklyDigestMode(env), isAdmin);
}

/** La case « alerte de résultat » est-elle proposée à cette personne ? */
export function saleResultsOfferedTo({
  isAdmin,
  env = process.env,
}: {
  isAdmin: boolean;
  env?: Env;
}): boolean {
  return offeredTo(saleResultsMode(env), isAdmin);
}
