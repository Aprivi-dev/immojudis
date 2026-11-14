/**
 * Fiche de vente que l'inscription ne doit pas perdre. La fiche note son adresse pour l'onglet
 * (`sessionStorage`) ; `/login` la reprend quand on y arrive sans paramètre `redirect` (« S'inscrire »
 * et « Connexion » de l'en-tête, qui restent sans JavaScript). Seul module qui connaît la clé et qui
 * lit la valeur.
 *
 * La valeur lue est BRUTE : `/login` la passe par sa validation de `redirect` (`parseLoginSearch`),
 * comme le paramètre qu'elle remplace ; une adresse extérieure y est refusée. Ce module n'importe
 * rien : il est dans le JavaScript initial de la fiche.
 *
 * `sessionStorage` peut manquer ou refuser l'accès (navigation privée, stockage bloqué ou plein) :
 * l'écriture ne fait alors rien et la lecture ne rend rien.
 */
const SIGNUP_RETURN_SALE_KEY = "immojudis.signup-return-sale";

/** Note l'adresse de la fiche consultée (`saleDetailPath`), pour l'onglet seulement. */
export function rememberSaleForSignup(path: string): void {
  try {
    window.sessionStorage.setItem(SIGNUP_RETURN_SALE_KEY, path);
  } catch {
    // Stockage indisponible : l'inscription mène où elle menait avant.
  }
}

/** L'adresse notée dans cet onglet, telle quelle (à valider comme un `redirect`), ou `undefined`. */
export function rememberedSaleForSignup(): string | undefined {
  try {
    return window.sessionStorage.getItem(SIGNUP_RETURN_SALE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}
