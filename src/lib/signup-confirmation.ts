/**
 * Compte « confirmé » pour la mesure du parcours (`signup_confirmed`) : l'événement part quand un
 * compte vient d'être confirmé et connecté, que ce soit par le lien reçu par email ou, si la
 * confirmation n'est pas exigée, dès l'inscription. `signup_submitted` (formulaire envoyé) le
 * précède et ne dit rien de la confirmation.
 *
 * Aucune donnée n'est conservée pour cela : on compare seulement les dates que le compte porte
 * déjà (`email_confirmed_at` et `last_sign_in_at`). Une confirmation ne compte que si elle date de
 * moins de `FRESH_CONFIRMATION_MS` et si la connexion est celle qui l'a suivie (une connexion
 * ultérieure d'un compte ancien ne compte pas). Un compte n'est compté qu'une fois par chargement
 * de page ; recharger la page dans la minute qui suit la confirmation peut le compter une
 * seconde fois (écart accepté, l'événement est un ordre de grandeur).
 */

const FRESH_CONFIRMATION_MS = 60_000;
const SAME_SIGN_IN_MS = 30_000;
const counted = new Set<string>();

type ConfirmableUser = {
  id: string;
  email_confirmed_at?: string | null;
  last_sign_in_at?: string | null;
};

export function isFreshlyConfirmed(user: ConfirmableUser, now = Date.now()): boolean {
  const confirmedAt = Date.parse(user.email_confirmed_at ?? "");
  const signedInAt = Date.parse(user.last_sign_in_at ?? "");
  if (!Number.isFinite(confirmedAt) || !Number.isFinite(signedInAt)) return false;
  return (
    now - confirmedAt >= -SAME_SIGN_IN_MS &&
    now - confirmedAt <= FRESH_CONFIRMATION_MS &&
    Math.abs(signedInAt - confirmedAt) <= SAME_SIGN_IN_MS
  );
}

export function trackSignupConfirmed(user: ConfirmableUser, now = Date.now()): void {
  if (counted.has(user.id) || !isFreshlyConfirmed(user, now)) return;
  counted.add(user.id);
  // Import à la demande : ce cas est rare, et le suivi du parcours reste hors du JavaScript commun.
  void import("@/lib/product-events").then(
    (module) => module.trackProductEvent("signup_confirmed"),
    () => undefined,
  );
}

/** Réservé aux tests. */
export function resetSignupConfirmationForTests(): void {
  counted.clear();
}
