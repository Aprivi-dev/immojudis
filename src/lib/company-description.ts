/**
 * Description unique de l'entreprise et du site. Cinq formulations différentes circulaient (description
 * du site, description Open Graph, accueil, page « À propos », `llms.txt`) : un assistant ou un moteur
 * qui les rapproche ne sait plus ce qu'est Immojudis. Cette phrase est la seule : elle sert à la
 * description du site (`layout.tsx`), à l'accueil, à la page « À propos », au JSON-LD
 * (`Organization` et `AboutPage`) et à l'en-tête de `/llms.txt`.
 *
 * 140 à 160 caractères (elle est aussi une meta description), sans promesse ni chiffre ni mot de la
 * liste que `editorial-metadata.test.ts` interdit. La changer ici suffit.
 */
export const COMPANY_NAME = "Immojudis";

export const COMPANY_DESCRIPTION =
  "Immojudis est une plateforme française d’exploration des ventes immobilières aux enchères : annonces référencées, procédures expliquées, aide à la décision.";
