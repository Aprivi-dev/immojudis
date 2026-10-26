/**
 * Lecture de la liste publique des pépites (`list_public_pepite_sale_ids`, migration 20261104100000) : les
 * identifiants des ventes publiables, jamais un montant. La base ne rend RIEN tant que le mode des pépites
 * n'est pas « on » : en mode « shadow » ou « off », la liste est vide et rien ne change sur le site.
 *
 * Module sans import serveur : partagé par la route `/api/catalogue/pepites` et par la recherche d'aperçu
 * (`runPreviewSearch`), qui lisent la liste avec le client anonyme du serveur.
 *
 * Une base sans la fonction (migration pas encore appliquée : `PGRST202` ou `42883`) vaut « aucune pépite » ;
 * toute autre erreur est levée, pour que l'appelant ne garde jamais en cache une panne.
 */
export type PepiteIdsClient = {
  rpc: (fn: "list_public_pepite_sale_ids") => PromiseLike<{ data: unknown; error: unknown }>;
};

/** Fonction de base absente (migration pas encore appliquée). */
export function isMissingPepiteFunction(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "PGRST202" || code === "42883";
}

/** Identifiants des pépites publiables, en minuscules ; vide quand la fonction est absente. */
export async function listPepiteSaleIds(client: PepiteIdsClient): Promise<string[]> {
  const { data, error } = await client.rpc("list_public_pepite_sale_ids");
  if (error) {
    if (isMissingPepiteFunction(error)) return [];
    throw error;
  }
  return Array.isArray(data)
    ? data.filter((id): id is string => typeof id === "string").map((id) => id.toLowerCase())
    : [];
}
