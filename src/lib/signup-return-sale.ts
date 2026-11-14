/**
 * Fiche de vente que l'inscription ne doit pas perdre. La fiche note son adresse pour l'onglet
 * (`sessionStorage`) ; `/login` la reprend quand on y arrive sans paramètre `redirect` (« S'inscrire »
 * et « Connexion » de l'en-tête, qui restent sans JavaScript), puis l'efface dès qu'une connexion ou
 * une inscription a réussi. Seul module qui connaît la clé, lit et efface la valeur.
 *
 * Minimisation (RGPD, art. 5.1.c) : seule l'adresse de la fiche est notée (`/sales/<id>`, sans
 * l'origine `?from=`) ; elle part dans le lien de confirmation de l'inscription (Supabase, puis le
 * prestataire d'e-mail).
 *
 * La valeur lue est BRUTE : `/login` la passe par sa validation de `redirect` (`parseLoginSearch`),
 * comme le paramètre qu'elle remplace ; une adresse extérieure y est refusée. Ce module n'importe
 * rien : il est dans le JavaScript initial de la fiche.
 *
 * `sessionStorage` peut manquer ou refuser l'accès (navigation privée, stockage bloqué ou plein) :
 * l'écriture ne fait alors rien et la lecture ne rend rien.
 */
const SIGNUP_RETURN_SALE_KEY = "immojudis.signup-return-sale";

/** Note l'adresse de la fiche consultée (`saleDetailPath(id)`, sans origine), pour l'onglet seulement. */
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

/** Efface la fiche notée : la connexion ou l'inscription l'a utilisée. */
export function forgetSaleForSignup(): void {
  try {
    window.sessionStorage.removeItem(SIGNUP_RETURN_SALE_KEY);
  } catch {
    // Stockage indisponible : rien n'y a été noté.
  }
}
