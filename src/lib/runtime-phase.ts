/** Valeur de `NEXT_PHASE` pendant `next build` (`PHASE_PRODUCTION_BUILD` de `next/constants`). */
const BUILD_PHASE = "phase-production-build";

/**
 * Vrai à l'exécution en production, faux pendant `next build`, en développement et en test.
 * `NEXT_PHASE` n'est positionné par Next.js que pendant le build : à l'exécution il est absent.
 *
 * Règle partagée des pages rendues à l'avance (ISR) qui lisent la base : en production, une
 * régénération qui ne peut pas lire la base doit lever l'erreur, pour que la dernière bonne page reste
 * servie (guide ISR de Next.js : « If an error is thrown while attempting to revalidate data, the last
 * successfully generated data will continue to be served from the cache »). Pendant `next build`
 * (sans base, comme dans l'environnement factice de la CI) le build ne doit pas échouer : la page est
 * produite sans sa liste. En développement et en test, il n'y a pas de page précédente à conserver.
 */
export function isProductionRuntime(
  env: { NODE_ENV?: string; NEXT_PHASE?: string } = process.env,
): boolean {
  return env.NODE_ENV === "production" && env.NEXT_PHASE !== BUILD_PHASE;
}
