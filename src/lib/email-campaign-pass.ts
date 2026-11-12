/**
 * Limites communes des passages d'envoi d'emails planifiés (rappels d'audience, alertes de
 * résultat, récapitulatif hebdomadaire, fin d'essai) : les routes de ces tâches ont 60 s.
 */

/** Marge sous les 60 s de la route : le passage s'arrête de lui-même, la suite au suivant. */
export const EMAIL_PASS_BUDGET_MS = 50_000;

/** Comptes traités en même temps dans un passage. */
export const EMAIL_PASS_USER_CONCURRENCY = 4;

/** Garde-fou : au-delà, le passage s'arrête là (les comptes suivants attendent le suivant). */
export const EMAIL_PASS_MAX_CONSENTING_USERS = 10_000;
