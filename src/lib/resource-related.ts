import { RESOURCE_SUMMARIES, type ResourceSummary } from "@/lib/resource-articles";

/**
 * Sujets des articles, pour choisir les « articles liés » d'une page. Un sujet commun pèse plus
 * qu'une catégorie commune (la catégorie est large : la moitié des articles sont des
 * « fondamentaux »). Les sujets sont tenus ici plutôt que dans les fichiers JSON des articles : un
 * article ajouté sans sujet reste proposé, par sa catégorie puis par son ordre dans le registre.
 */
export type ResourceTopic =
  | "procedure"
  | "audience"
  | "avocat"
  | "documents"
  | "budget"
  | "financement"
  | "analyse"
  | "occupation"
  | "investissement"
  | "types-de-vente"
  | "apres-vente";

export const RESOURCE_TOPICS: Readonly<Record<string, readonly ResourceTopic[]>> = {
  "ventes-immobilieres-judiciaires": ["procedure", "audience", "documents", "budget"],
  "jour-audience-encheres-role-avocat": ["audience", "avocat", "procedure"],
  "apres-adjudication-surenchere-paiement-titre-vente": ["apres-vente", "budget", "procedure"],
  "ventes-notariales-domaniales-differences-tribunal": ["types-de-vente", "procedure"],
  "lire-cahier-conditions-vente-preparer-visite": ["documents", "analyse", "occupation"],
  "frais-vente-encheres-judiciaire": ["budget", "apres-vente"],
  "financer-achat-encheres-pret-delais": ["financement", "budget"],
  "prix-plafond-encheres-immobilieres": ["budget", "analyse", "audience"],
  "acheter-bien-occupe-encheres": ["occupation", "documents", "analyse"],
  "immeuble-rapport-encheres": ["investissement", "occupation", "analyse"],
  "analyser-opportunite-encheres": ["analyse", "documents", "investissement"],
  "saisie-immobiliere-etapes-vente-forcee-acheteur": ["procedure", "types-de-vente"],
  "licitation-vente-bien-indivis-encheres-acheteur": ["types-de-vente", "procedure"],
  "avocat-obligatoire-encherir-tribunal-choisir-mandat-cout": ["avocat", "audience", "budget"],
};

const TOPIC_WEIGHT = 3;
const CATEGORY_WEIGHT = 1;

function topicsOf(slug: string): readonly ResourceTopic[] {
  return RESOURCE_TOPICS[slug] ?? [];
}

/**
 * Les articles les plus proches de `slug` : sujets partagés d'abord (3 points chacun), même
 * catégorie ensuite (1 point), puis l'ordre du registre. L'article lui-même n'en fait jamais
 * partie. Sans aucun point commun, l'ordre du registre décide, comme avant.
 */
export function relatedResources(
  slug: string,
  limit = 3,
  candidates: readonly ResourceSummary[] = RESOURCE_SUMMARIES,
): ResourceSummary[] {
  const current = candidates.find((item) => item.slug === slug);
  const topics = new Set(topicsOf(slug));
  return candidates
    .filter((item) => item.slug !== slug)
    .map((item, index) => {
      const shared = topicsOf(item.slug).filter((topic) => topics.has(topic)).length;
      const sameCategory = current != null && current.category === item.category ? 1 : 0;
      return { item, index, score: shared * TOPIC_WEIGHT + sameCategory * CATEGORY_WEIGHT };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map(({ item }) => item);
}

/**
 * Articles à lire avant de miser sur les ventes d'une page de département ou de tribunal : ce qui
 * se passe à l'audience et ce qu'il faut vérifier dans le dossier. Deux articles pris dans un
 * petit lot, selon un nombre propre à la page (le code du département, par exemple) : toutes les
 * pages ne reprennent pas les deux mêmes liens, et un article retiré du registre est sauté.
 */
const UNDERSTAND_POOL = [
  "avocat-obligatoire-encherir-tribunal-choisir-mandat-cout",
  "lire-cahier-conditions-vente-preparer-visite",
  "jour-audience-encheres-role-avocat",
  "frais-vente-encheres-judiciaire",
  "prix-plafond-encheres-immobilieres",
  "saisie-immobiliere-etapes-vente-forcee-acheteur",
] as const;

export function understandingResources(
  seed: string,
  candidates: readonly ResourceSummary[] = RESOURCE_SUMMARIES,
): ResourceSummary[] {
  const available = UNDERSTAND_POOL.map((slug) =>
    candidates.find((item) => item.slug === slug),
  ).filter((item): item is ResourceSummary => item != null);
  if (available.length <= 2) return available;
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const first = hash % available.length;
  // Le second est toujours distinct du premier et ne dépend que de la page : stable d'un rendu à l'autre.
  const second =
    (first + 1 + (Math.floor(hash / available.length) % (available.length - 1))) % available.length;
  return [available[first], available[second]];
}
