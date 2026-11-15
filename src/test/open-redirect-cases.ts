/**
 * Adresses de retour (`redirect`, `redirect_to`) partagées par les tests des fonctions qui les
 * valident : une forme hostile ajoutée ici est essayée contre chacune d'elles.
 */

/**
 * Chemins qui commencent par `/` mais qu'un navigateur suivrait vers un autre site : une fois
 * normalisés par `URL` (`.` et `..` résolus, tabulations retirées) ou décodés, ils deviennent
 * `//evil.example` ou `/\evil.example`.
 */
export const HOSTILE_LOCAL_LOOKING_PATHS = [
  "/.//evil.example",
  "/..//evil.example",
  "/sales/..//evil.example",
  "/%2e%2e//evil.example",
  "/%2E%2E//evil.example",
  "/%2e//evil.example",
  "//evil.example",
  "///evil.example",
  "/\\evil.example",
  "/./\\evil.example",
  "/%5Cevil.example",
  "/%5cevil.example",
  "/%2F%2Fevil.example",
  "/%2f/evil.example",
  "/%252F%252Fevil.example",
  "/\t/evil.example",
  "/%09/evil.example",
  "/%0A/evil.example",
  "/%0d/evil.example",
  "/sales/..%2F%2Fevil.example",
  "/%2e%2e%2F%2Fevil.example",
] as const;

/** Pages du site qui doivent rester acceptées. */
export const VALID_LOCAL_PATHS = [
  "/sales/4655881c-249d-4eab-beba-f2624d8a1af0",
  "/sales?x=1#y",
  `/bienvenue?retour=${encodeURIComponent("/sales/4655881c-249d-4eab-beba-f2624d8a1af0")}`,
  "/sales?city=Bordeaux&q=%2F%2Fpas-un-hote",
] as const;
