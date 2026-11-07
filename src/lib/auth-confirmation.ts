import { decodeURIComponentSafe as decodeOnce } from "@/lib/safe-decode-uri";
/**
 * Lien des emails d'authentification (`/auth/confirmer`), lu côté navigateur.
 *
 * Les gabarits de `supabase/templates/` ne renvoient plus vers le point de vérification de Supabase
 * (`…supabase.co/auth/v1/verify`, que les passerelles anti-hameçonnage ouvrent et qui consomme alors
 * le jeton) mais vers une page d'Immojudis qui ne vérifie qu'AU CLIC sur un bouton :
 *
 *   https://immojudis.com/auth/confirmer?token_hash={{ .TokenHash }}&type=signup&redirect_to={{ .RedirectTo }}
 *
 * `redirect_to` est le DERNIER paramètre : `{{ .RedirectTo }}` n'est pas garanti encodé (il peut porter
 * lui-même un `?` ou un `&`), tout ce qui suit `redirect_to=` lui appartient. Module pur, sans
 * dépendance : il est testé sans navigateur.
 */

/** Types de lien admis (`EmailOtpType` de Supabase, moins `email` : aucun gabarit n'en émet). */
export const AUTH_LINK_TYPES = [
  "signup",
  "recovery",
  "email_change",
  "magiclink",
  "invite",
] as const;
export type AuthLinkType = (typeof AUTH_LINK_TYPES)[number];

export type AuthLink = {
  tokenHash: string;
  type: AuthLinkType;
  /** Adresse de retour demandée, brute (décodée) ; à valider avec `postConfirmationPath`. */
  redirectTo: string | null;
};

/** Page où la personne arrive quand `redirect_to` est absent ou n'est pas du site. */
export const DEFAULT_AFTER_CONFIRMATION_PATH = "/bienvenue";
/** Page de saisie du nouveau mot de passe : `PasswordRecovery` y retrouve la session ouverte. */
export const PASSWORD_RESET_PATH = "/reinitialiser-mot-de-passe";
/** Le chemin de la page elle-même : jamais une destination (boucle). */
export const AUTH_CONFIRMATION_PATH = "/auth/confirmer";

const TOKEN_HASH_PATTERN = /^[A-Za-z0-9._-]{8,512}$/;

function isAuthLinkType(value: string | null): value is AuthLinkType {
  return value !== null && (AUTH_LINK_TYPES as readonly string[]).includes(value);
}

/** Lit `?token_hash=…&type=…&redirect_to=…` ; `null` si le jeton ou le type manquent ou sont invalides. */
export function parseAuthLink(search: string): AuthLink | null {
  const query = search.startsWith("?") ? search.slice(1) : search;
  // `redirect_to` est le dernier paramètre : tout ce qui suit lui appartient, `&` et `?` compris.
  const marker = /(?:^|&)redirect_to=/.exec(query);
  const head = marker ? query.slice(0, marker.index) : query;
  const redirectRaw = marker ? query.slice(marker.index + marker[0].length) : "";
  const params = new URLSearchParams(head);
  const tokenHash = params.get("token_hash");
  const type = params.get("type");
  if (!tokenHash || !TOKEN_HASH_PATTERN.test(tokenHash) || !isAuthLinkType(type)) return null;
  return { tokenHash, type, redirectTo: redirectRaw ? decodeOnce(redirectRaw) : null };
}

/**
 * Où mener la personne une fois le lien vérifié :
 * - mot de passe oublié : la page de saisie du nouveau mot de passe, toujours ;
 * - sinon `redirect_to`, seulement s'il est de la même origine que le site (jamais une adresse
 *   étrangère, jamais la page de confirmation elle-même), réduit à son chemin, sa requête et son
 *   fragment ;
 * - sinon `/bienvenue`.
 */
export function postConfirmationPath(link: AuthLink, origin: string): string {
  if (link.type === "recovery") return PASSWORD_RESET_PATH;
  if (!link.redirectTo) return DEFAULT_AFTER_CONFIRMATION_PATH;
  return sameSitePath(link.redirectTo, origin) ?? DEFAULT_AFTER_CONFIRMATION_PATH;
}

/**
 * Chemin (`pathname + search + hash`) d'une adresse du site, ou `null`. Les contrôles portent sur le
 * résultat NORMALISÉ par `URL` (`/.//evil`, `/a/..//evil`, `/%2e//evil`, `/./\evil` deviennent
 * `//evil`, que `router.replace` lirait comme un autre site), jamais sur la chaîne brute : le chemin
 * doit commencer par UN seul `/`, et résolu contre l'origine il doit y rester. La page de
 * confirmation elle-même est refusée (boucle), sans tenir compte de la casse ni des `/` multiples.
 */
export function sameSitePath(candidate: string, origin: string): string | null {
  try {
    const base = new URL(origin).origin;
    const target = new URL(candidate, base);
    if (target.origin !== base) return null;
    const path = `${target.pathname}${target.search}${target.hash}`;
    if (!/^\/(?![/\\])/.test(path)) return null;
    if (new URL(path, base).origin !== base) return null;
    const flat = target.pathname.toLowerCase().replace(/\/{2,}/g, "/");
    if (flat === AUTH_CONFIRMATION_PATH || flat.startsWith(`${AUTH_CONFIRMATION_PATH}/`)) {
      return null;
    }
    return path;
  } catch {
    return null;
  }
}

/** Page d'échec d'un lien de mot de passe : celle que `PasswordRecovery` sait afficher. */
export const PASSWORD_RESET_EXPIRED_PATH = `${PASSWORD_RESET_PATH}?error=otp_expired`;
