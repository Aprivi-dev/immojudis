/**
 * Plafond des montants saisis dans les simulateurs de la page frais (budget total, prix
 * d'adjudication pour la surenchère) : dix milliards d'euros, très au-delà de toute vente
 * immobilière réelle.
 *
 * Il existe pour que les calculs restent exacts et bornés : au-delà de ~9e15, les nombres entiers
 * ne sont plus représentables un à un en virgule flottante, et la recherche par dichotomie du mode
 * budget ne convergerait plus. Au-delà du plafond, les calculs rendent un résultat « trop élevé »
 * (budget) ou `null` (surenchère), que l'interface explique à l'utilisateur.
 */
export const MAX_SIMULATOR_AMOUNT_EUR = 10_000_000_000;
