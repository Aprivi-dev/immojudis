/**
 * Filtre « Pépites seulement » de `/sales` et pastilles « Pépite » des cartes, du tableau et de la carte :
 * une seule lecture de la liste publique des identifiants (`GET /api/catalogue/pepites`, qui lit
 * `list_public_pepite_sale_ids`), gardée 5 minutes dans le navigateur, comme `market-range-filter.ts`. Jamais
 * un appel par carte.
 *
 * Contrairement au filtre « sous la fourchette », la liste passe par notre domaine (réponse mise en cache par
 * le CDN) : le filtre est ouvert aux visiteurs sans compte, et un visiteur ne charge pas le client Supabase
 * pour cela.
 *
 * Une base sans la fonction donne une liste vide (la route répond alors 200 `{ids: []}`), jamais « toutes les ventes »
 * à la place de la liste. Une erreur de lecture (429, 503, réponse illisible) est levée : ni la page ni la recherche
 * ne la prennent pour « aucune pépite » en cache. Tant que le mode des pépites n'est pas « on », la liste est vide : le filtre n'est pas proposé
 * (`pepitesActive`) et aucune pastille ne s'affiche.
 */
export const PEPITE_IDS_API_PATH = "/api/catalogue/pepites";
export const PEPITE_FILTER_UNAVAILABLE_MESSAGE =
  "Le filtre « Pépites seulement » est momentanément indisponible. Retirez-le ou réessayez dans un instant.";

const CACHE_MS = 5 * 60_000;

type PepiteLists = { ids: ReadonlySet<string>; exposedIds: ReadonlySet<string> };

let cached: { at: number; lists: Promise<PepiteLists> } | null = null;

function idSet(value: unknown): Set<string> {
  return new Set(
    (Array.isArray(value) ? value : [])
      .filter((id): id is string => typeof id === "string")
      .map((id) => id.toLowerCase()),
  );
}

async function readPepiteLists(): Promise<PepiteLists> {
  const response = await fetch(PEPITE_IDS_API_PATH, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(PEPITE_FILTER_UNAVAILABLE_MESSAGE);
  const body = (await response.json().catch(() => null)) as {
    ids?: unknown;
    exposedIds?: unknown;
  } | null;
  if (!Array.isArray(body?.ids)) throw new Error(PEPITE_FILTER_UNAVAILABLE_MESSAGE);
  return { ids: idSet(body.ids), exposedIds: idSet(body.exposedIds) };
}

function readLists(now: number): Promise<PepiteLists> {
  if (cached && now - cached.at < CACHE_MS) return cached.lists;
  const entry = { at: now, lists: readPepiteLists() };
  cached = entry;
  entry.lists.catch(() => {
    // Une panne n'est pas gardée : le prochain appel relit la liste.
    if (cached === entry) cached = null;
  });
  return entry.lists;
}

/**
 * Identifiants (en minuscules) des pépites publiables. Une erreur (429, 503, réseau) est LEVÉE et n'est pas gardée :
 * l'appelant (React Query, recherche) ne met pas « aucune pépite » en cache cinq minutes sur une panne passagère.
 * Une base sans la fonction, ou un mode qui n'est pas « on », donnent une liste vide, que la route rend en 200.
 */
export async function fetchPepiteSaleIds(now = Date.now()): Promise<ReadonlySet<string>> {
  return (await readLists(now)).ids;
}

/**
 * Parmi les pépites, celles dont le bien est dans le périmètre d'un plan de prévention des risques d'inondation
 * (mention courte « zonage à vérifier ») : la même lecture, gardée avec la liste.
 */
export async function fetchPepiteFloodExposedIds(now = Date.now()): Promise<ReadonlySet<string>> {
  return (await readLists(now)).exposedIds;
}

/** Les pépites sont ouvertes au public : la liste n'est pas vide (elle l'est tant que le mode n'est pas « on »). */
export function pepitesActive(ids: ReadonlySet<string> | undefined): boolean {
  return (ids?.size ?? 0) > 0;
}

/** Pour les tests : oublie la liste gardée. */
export function resetPepiteSaleIdsCache(): void {
  cached = null;
}
