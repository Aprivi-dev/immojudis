import { tryLoadPublicTribunalDirectory } from "@/lib/public-tribunal-directory.server";
import type { PublicTribunalActivity } from "@/lib/public-tribunal-activity";
import { ambiguousTribunalCodes } from "@/lib/tribunal-pages";

/**
 * Les tribunaux qui n'ont pas d'adresse lisible parce qu'un autre tribunal du référentiel complet
 * porte le même nom (voir `ambiguousTribunalCodes`). Un seul calcul pour les liens des listes, le
 * sitemap et la page d'un tribunal. Le référentiel est lu avec les tribunaux à ventes ; s'il est en
 * panne, seuls les homonymes parmi les tribunaux à ventes sont connus (les liens qui en résultent
 * restent corrigés par la page, qui lève une erreur plutôt que de servir une adresse ambiguë).
 */
export async function loadAmbiguousTribunalCodes(
  items: readonly PublicTribunalActivity[],
): Promise<Set<string>> {
  const directory = await tryLoadPublicTribunalDirectory();
  return ambiguousTribunalCodes([...items, ...(directory.status === "ok" ? directory.items : [])]);
}
