import { serverEnv, type EnvSource } from "@/lib/env";

/**
 * Interrupteurs d'envoi des emails à consentement : les rappels d'audience et avertissements graves
 * (`SALE_REMINDERS_MODE`), le récapitulatif hebdomadaire « Ma semaine » (`WEEKLY_DIGEST_MODE`) et
 * l'alerte de résultat ou de remise en vente (`SALE_RESULTS_MODE`) et les emails de nouveautés et
 * d'offres (`MARKETING_EMAILS_MODE`). Une seule règle :
 *
 * - `off` (défaut, et toute valeur inconnue) : rien n'est envoyé, la case de consentement n'est
 *   pas proposée ;
 * - `internal` : seuls les administrateurs reçoivent les emails (et voient la case), pour mesurer
 *   les fausses alertes sur de vraies ventes avant l'ouverture ;
 * - `on` : toutes les personnes qui ont consenti.
 *
 * Un doute sur la valeur ferme l'envoi : une faute de frappe ne peut pas ouvrir l'envoi à tous. Le
 * propriétaire n'ouvre qu'après avoir mis à jour la politique de confidentialité et le registre des
 * traitements.
 */
const EMAIL_FEATURE_MODES = ["off", "internal", "on"] as const;
export type EmailFeatureMode = (typeof EMAIL_FEATURE_MODES)[number];

type Env = Pick<NodeJS.ProcessEnv, string>;

function parseMode(value: string | undefined): EmailFeatureMode {
  const mode = value?.toLowerCase();
  return mode === "internal" || mode === "on" ? mode : "off";
}

/** Mode des rappels d'audience et des avertissements graves (`SALE_REMINDERS_MODE`). */
export function saleRemindersMode(env: Env = process.env): EmailFeatureMode {
  return parseMode(serverEnv(env as EnvSource).saleReminders.mode);
}

/** Mode du récapitulatif hebdomadaire « Ma semaine » (`WEEKLY_DIGEST_MODE`). */
export function weeklyDigestMode(env: Env = process.env): EmailFeatureMode {
  return parseMode(serverEnv(env as EnvSource).weeklyDigest.mode);
}

/** Mode de l'alerte de résultat ou de remise en vente (`SALE_RESULTS_MODE`). */
export function saleResultsMode(env: Env = process.env): EmailFeatureMode {
  return parseMode(serverEnv(env as EnvSource).saleResults.mode);
}

/**
 * Mode des emails de nouveautés et d'offres d'Immojudis (`MARKETING_EMAILS_MODE`). Aucun de ces
 * emails n'existe encore : l'interrupteur ne commande que le recueil du consentement (case proposée
 * ou non, consentement accepté ou refusé par le serveur).
 */
export function marketingEmailsMode(env: Env = process.env): EmailFeatureMode {
  return parseMode(serverEnv(env as EnvSource).marketingEmails.mode);
}

/**
 * Interrupteur d'envoi des alertes par email (`ALERT_NOTIFICATIONS_MODE`), ajouté à une fonction
 * déjà en service : contrairement aux autres modes, la variable ABSENTE (ou vide) vaut `on`, pour
 * ne rien changer à l'existant. Une valeur présente mais inconnue (faute de frappe) vaut `off` :
 * le doute ferme l'envoi.
 *
 * - `off` : aucun email d'alerte ne part, les emails restent en file (les notifications dans
 *   l'application continuent) ;
 * - `internal` : seuls les administrateurs reçoivent les emails d'alerte ;
 * - `on` : toutes les personnes qui ont consenti.
 */
export function alertNotificationsMode(env: Env = process.env): EmailFeatureMode {
  const value = serverEnv(env as EnvSource).alertNotifications.mode?.toLowerCase();
  if (value === undefined) return "on";
  return value === "internal" || value === "on" ? value : "off";
}

/**
 * Mode de l'email de fin d'essai à J+5 (`TRIAL_END_EMAIL_MODE`), mêmes valeurs que les autres : `off`
 * (défaut) n'envoie rien ; `internal` envoie un exemple, objet « [Test interne] », aux seuls
 * administrateurs (jamais à un compte réel) ; `on` écrit aux comptes dont l'essai se termine dans deux
 * jours. Il n'y a pas de case de consentement : c'est un message sur le compte, avec lien de
 * désinscription en un clic (liste d'exclusion `launch_offer_end_notice_optouts`).
 */
export function trialEndEmailMode(env: Env = process.env): EmailFeatureMode {
  return parseMode(serverEnv(env as EnvSource).trialEndEmail.mode);
}

/**
 * Mode de l'email unique de prise en main, le lendemain de l'inscription (`ONBOARDING_EMAIL_MODE`),
 * mêmes valeurs que les autres : `off` (défaut) ne lit ni n'envoie rien ; `internal` envoie un exemple,
 * objet « [Test interne] », aux seuls administrateurs (aucun compte réel n'est lu ni écrit) ; `on` écrit
 * aux comptes de la file `get_onboarding_email_queue`. Pas de case de consentement : message de service,
 * base légale l'intérêt légitime, avec lien d'opposition en un clic (liste d'exclusion
 * `onboarding_email_optouts`).
 */
export function onboardingEmailMode(env: Env = process.env): EmailFeatureMode {
  return parseMode(serverEnv(env as EnvSource).onboardingEmail.mode);
}

function offeredTo(mode: EmailFeatureMode, isAdmin: boolean): boolean {
  return mode === "on" || (mode === "internal" && isAdmin);
}

/** La case « rappels d'audience » est-elle proposée à cette personne ? */
export function saleRemindersOfferedTo({
  isAdmin,
  env = process.env,
}: {
  isAdmin: boolean;
  env?: Env;
}): boolean {
  return offeredTo(saleRemindersMode(env), isAdmin);
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

/** La case « nouveautés et offres » est-elle proposée à cette personne ? */
export function marketingEmailsOfferedTo({
  isAdmin,
  env = process.env,
}: {
  isAdmin: boolean;
  env?: Env;
}): boolean {
  return offeredTo(marketingEmailsMode(env), isAdmin);
}
