/**
 * Lecture de la liste publique des pépites (`list_public_pepite_sale_ids`, migration 20261104100000) : les
 * identifiants des ventes publiables, jamais un montant. La base ne rend RIEN tant que le mode des pépites
 * n'est pas « on » : en mode « shadow » ou « off », la liste est vide et rien ne change sur le site.
 *
 * Module sans import serveur : partagé par la route `/api/catalogue/pepites` et par la recherche d'aperçu
 * (`runPreviewSearch`), qui lisent la liste avec le client anonyme du serveur.
 *
 * Une base sans la fonction (migration pas encore appliquée : `isMissingDatabaseObject`) vaut « aucune pépite » ;
 * toute autre erreur est levée, pour que l'appelant ne garde jamais en cache une panne.
 */
import { isMissingDatabaseObject } from "@/lib/postgrest-errors";

export type PepiteIdsClient = {
  rpc: (fn: "list_public_pepite_sale_ids") => PromiseLike<{ data: unknown; error: unknown }>;
};

export type PepiteFloodIdsClient = {
  rpc: (
    fn: "list_public_pepite_flood_exposed_ids",
  ) => PromiseLike<{ data: unknown; error: unknown }>;
};

/** Identifiants des pépites publiables, en minuscules ; vide quand la fonction est absente. */
export async function listPepiteSaleIds(client: PepiteIdsClient): Promise<string[]> {
  const { data, error } = await client.rpc("list_public_pepite_sale_ids");
  if (error) {
    if (isMissingDatabaseObject(error)) return [];
    throw error;
  }
  return Array.isArray(data)
    ? data.filter((id): id is string => typeof id === "string").map((id) => id.toLowerCase())
    : [];
}

/**
 * Identifiants, parmi les pépites publiables, de celles dont le bien est dans le périmètre d'un plan de prévention
 * des risques d'inondation (`list_public_pepite_flood_exposed_ids`) : un fait public, sans montant, qui sert à
 * afficher la mention courte « zonage à vérifier » partout où le badge Pépite apparaît. Vide quand la fonction est
 * absente (migration pas encore appliquée), en mode « shadow » ou sous une règle sans inondation (`pepite-v1`, `pepite-v1.1`, `pepite-v1.2`).
 */
export async function listPepiteFloodExposedIds(client: PepiteFloodIdsClient): Promise<string[]> {
  const { data, error } = await client.rpc("list_public_pepite_flood_exposed_ids");
  if (error) {
    if (isMissingDatabaseObject(error)) return [];
    throw error;
  }
  return Array.isArray(data)
    ? data.filter((id): id is string => typeof id === "string").map((id) => id.toLowerCase())
    : [];
}
