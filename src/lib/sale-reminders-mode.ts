/**
 * Mode d'envoi des rappels d'audience et des avertissements graves (variable `SALE_REMINDERS_MODE`) :
 *
 * - `off` (défaut, et toute valeur inconnue) : rien n'est envoyé, la case de consentement n'est
 *   pas proposée ;
 * - `internal` : seuls les administrateurs reçoivent les emails (et voient la case), pour mesurer
 *   les fausses alertes sur de vraies ventes avant l'ouverture ;
 * - `on` : toutes les personnes qui ont consenti.
 *
 * Un doute sur la valeur ferme l'envoi : une faute de frappe ne peut pas ouvrir l'envoi à tous.
 */
export const SALE_REMINDERS_MODES = ["off", "internal", "on"] as const;
export type SaleRemindersMode = (typeof SALE_REMINDERS_MODES)[number];

export function saleRemindersMode(
  env: Pick<NodeJS.ProcessEnv, string> = process.env,
): SaleRemindersMode {
  const value = env.SALE_REMINDERS_MODE?.trim().toLowerCase();
  return value === "internal" || value === "on" ? value : "off";
}

/** La case « rappels d'audience » est-elle proposée à cette personne ? */
export function saleRemindersOfferedTo({
  isAdmin,
  env = process.env,
}: {
  isAdmin: boolean;
  env?: Pick<NodeJS.ProcessEnv, string>;
}): boolean {
  const mode = saleRemindersMode(env);
  return mode === "on" || (mode === "internal" && isAdmin);
}
