import { getResourceArticle } from "@/lib/resource-articles";

const SURENCHERE_ARTICLE_SLUG = "apres-adjudication-surenchere-paiement-titre-vente";

/**
 * Rappel de la règle de la surenchère, repris mot pour mot de l'article
 * `src/content/resources/apres-adjudication-surenchere-paiement-titre-vente.json` (lecture seule) :
 * rien n'est reformulé ici, pour que le simulateur et l'article ne puissent pas se contredire.
 * Serveur uniquement (la page le passe au composant) : l'import charge tous les articles.
 */
export type SurenchereReminder = {
  /** Le délai et le montant minimal, tels que formulés dans les points à retenir de l'article. */
  delay: string;
  /** Dans quels types de vente la règle s'applique, telle que l'article la formule. */
  scope: string | null;
  articleHref: string;
  articleTitle: string;
};

export function getSurenchereReminder(): SurenchereReminder | null {
  const article = getResourceArticle(SURENCHERE_ARTICLE_SLUG);
  if (!article) return null;
  const delay = article.takeaways.find((item) => /dix jours/i.test(item) && /dixième/i.test(item));
  if (!delay) return null;
  const scope = article.sections
    .find((section) => section.id === "surenchere")
    ?.bullets?.find((bullet) => /surenchère du dixième/i.test(bullet));
  return {
    delay,
    scope: scope ?? null,
    articleHref: article.href,
    articleTitle: article.title,
  };
}
