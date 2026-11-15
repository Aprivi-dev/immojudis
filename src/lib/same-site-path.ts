const PERCENT_ESCAPE = /%([0-9A-Fa-f]{2})/g;
/** Décodages examinés ; une adresse du site en demande au plus deux ou trois (`/bienvenue?retour=`). */
const MAX_DECODES = 5;

/**
 * Règle commune des adresses de retour (`redirect` de `/login`, `redirect_to` des emails
 * d'authentification) : le chemin (`pathname + search + hash`) d'une adresse de `origin` (sans `/`
 * final), reconstruit par `URL`, ou `null`. `candidate` peut être un chemin ou une adresse absolue.
 *
 * Les contrôles portent sur l'adresse NORMALISÉE par `URL`, jamais sur la chaîne brute : `/.//evil`,
 * `/a/..//evil`, `/%2e%2e//evil`, `/./\evil` ou `/<tab>/evil` y deviennent `//evil` (`URL` lit `\`
 * comme `/` et retire tabulations et retours à la ligne), qu'un navigateur et `router.push` suivent
 * vers un autre site. Ils portent aussi sur chacune de ses formes décodées (`/%2F%2Fevil`,
 * `/%5Cevil`, `/%09/evil`, `%25` en cascade), pour qu'un décodage plus loin (lien d'email relu,
 * paramètre recopié) ne fasse pas sortir du site.
 *
 * Module à part, chargé par `/login` et `auth-confirmation.ts` seulement : `loginPathWithRedirect`
 * (`navigation.ts`, dans le JavaScript initial de chaque page) ne valide pas et s'en remet à `/login`.
 */
export function sameSitePath(candidate: string, origin: string): string | null {
  try {
    const { pathname, search, hash } = new URL(candidate, origin);
    // Chaque décodage : `%XX` en son octet, sans lever sur un `%` mal formé. Au plus
    // `MAX_DECODES` : chaque tour relit toute la chaîne, et une chaîne qui change encore après
    // (`%25` empilés) est refusée plutôt que de coûter un temps quadratique.
    for (let form = candidate, decodes = 0; ; decodes += 1) {
      const url = new URL(form, origin);
      if (url.origin !== origin || url.pathname.startsWith("//")) return null;
      const decoded = form.replace(PERCENT_ESCAPE, (_, hex: string) =>
        String.fromCharCode(parseInt(hex, 16)),
      );
      if (decoded === form) break;
      if (decodes === MAX_DECODES) return null;
      form = decoded;
    }
    return `${pathname}${search}${hash}`;
  } catch {
    return null;
  }
}
