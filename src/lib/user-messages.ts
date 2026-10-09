export const GENERIC_ERROR_MESSAGE = "Une erreur est survenue. Réessayez dans un instant.";

type ErrorLike = {
  code?: unknown;
  status?: unknown;
  message?: unknown;
  name?: unknown;
};

// Anything that smells like infrastructure or SQL must never reach a visitor.
const TECHNICAL_MARKER =
  /\b(pgrst|postgrest|postgres|supabase|stripe|jwt|relation|column|constraint|violates|syntax error|rpc|policy|schema|undefined|null|typeerror|referenceerror|econn|enotfound|etimedout|stack|sql)\b|[{}[\]]/i;
const FRENCH_SENTENCE =
  /[àâçéèêëîïôûùüÿœ]|^(vous|votre|vos|le|la|les|une|un|impossible|cette|ce|choisissez|précisez|veuillez|aucun|aucune)\b|\b(temporairement|indisponibles?|introuvables?|invalides?|requise?|réessayez|vérifiez|pour|des|du|est|sont|pas|trop)\b/i;

const KNOWN_MESSAGES: Array<[RegExp, string]> = [
  [/invalid login credentials/i, "Email ou mot de passe incorrect."],
  [/email not confirmed/i, "Confirmez votre adresse email avant de vous connecter."],
  [/user already registered|already been registered/i, "Un compte existe déjà avec cette adresse."],
  [/password should be at least|password is too short/i, "Le mot de passe est trop court."],
  [
    /password.*(weak|pwned|known to be)/i,
    "Ce mot de passe est trop faible. Choisissez-en un autre.",
  ],
  [
    /connexion requise|not authenticated|not logged in|auth session missing/i,
    "Connectez-vous pour continuer.",
  ],
  [/new password should be different/i, "Le nouveau mot de passe doit être différent de l'ancien."],
  [/unable to validate email address|invalid email/i, "Cette adresse email n'est pas valide."],
  [
    /email rate limit|over_email_send_rate_limit/i,
    "Trop d'emails envoyés. Patientez quelques minutes.",
  ],
  [
    /jwt expired|session.*(expired|not found)|refresh token/i,
    "Votre session a expiré. Reconnectez-vous.",
  ],
  [
    /statement timeout|canceling statement|57014/i,
    "Le service met trop de temps à répondre. Réessayez dans quelques secondes.",
  ],
  [
    /failed to fetch|networkerror|load failed|network request failed|fetch failed/i,
    "Connexion impossible. Vérifiez votre réseau puis réessayez.",
  ],
  [
    /rate limit|too many requests|\b429\b/i,
    "Trop de demandes. Patientez un instant avant de réessayer.",
  ],
  [
    /not authorized|permission denied|row-level security|\b42501\b|forbidden|\b403\b/i,
    "Vous n'avez pas accès à cette action.",
  ],
];

function readMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const { message } = error as ErrorLike;
    if (typeof message === "string") return message;
  }
  return "";
}

/**
 * Turn any thrown value into a sentence that is safe and useful to show to a
 * visitor. Messages written by the application itself (French, no technical
 * vocabulary) pass through; everything else is translated or replaced.
 */
export function userMessage(error: unknown, fallback: string = GENERIC_ERROR_MESSAGE): string {
  const message = readMessage(error).trim();
  const status = error && typeof error === "object" ? (error as ErrorLike).status : undefined;
  const code = error && typeof error === "object" ? (error as ErrorLike).code : undefined;
  const haystack = [message, typeof code === "string" ? code : "", status === 429 ? "429" : ""]
    .filter(Boolean)
    .join(" ");

  for (const [pattern, text] of KNOWN_MESSAGES) {
    if (pattern.test(haystack)) return text;
  }
  const applicationMessage =
    Boolean(message) && FRENCH_SENTENCE.test(message) && !TECHNICAL_MARKER.test(message);
  if (applicationMessage) return message;
  if (status === 401) return "Votre session a expiré. Reconnectez-vous.";
  if (typeof status === "number" && status >= 500) {
    return "Le service est momentanément indisponible. Réessayez dans quelques instants.";
  }
  return fallback;
}
