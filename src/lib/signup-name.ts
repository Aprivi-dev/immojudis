/** Longueur maximale d'un prénom ou d'un nom saisi à l'inscription. */
export const SIGNUP_NAME_MAX_LENGTH = 80;

export type SignupName = {
  firstName: string;
  lastName: string;
  /** « Prénom Nom », comme `full_name` l'a toujours été (profil, administration). */
  fullName: string;
};

export type SignupNameResult =
  | { ok: true; name: SignupName }
  | { ok: false; field: "first_name" | "last_name"; message: string };

/** Espaces de tête, de queue et doublons retirés : « Jean   Marc » devient « Jean Marc ». */
function normalizeNamePart(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Prénom et nom de l'inscription : les deux sont obligatoires. Le même contrôle sert au formulaire
 * et à tout code qui construit les métadonnées du compte (`full_name`, `first_name`, `last_name`).
 */
export function validateSignupName(firstName: string, lastName: string): SignupNameResult {
  const first = normalizeNamePart(firstName);
  const last = normalizeNamePart(lastName);
  if (!first) {
    return { ok: false, field: "first_name", message: "Renseignez votre prénom." };
  }
  if (!last) {
    return { ok: false, field: "last_name", message: "Renseignez votre nom." };
  }
  if (first.length > SIGNUP_NAME_MAX_LENGTH) {
    return {
      ok: false,
      field: "first_name",
      message: `Votre prénom ne peut pas dépasser ${SIGNUP_NAME_MAX_LENGTH} caractères.`,
    };
  }
  if (last.length > SIGNUP_NAME_MAX_LENGTH) {
    return {
      ok: false,
      field: "last_name",
      message: `Votre nom ne peut pas dépasser ${SIGNUP_NAME_MAX_LENGTH} caractères.`,
    };
  }
  return { ok: true, name: { firstName: first, lastName: last, fullName: `${first} ${last}` } };
}
