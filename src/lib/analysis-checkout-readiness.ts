import { resolveEmailAlertDeliveryConfig } from "@/lib/email-alerts";
import { serverEnv } from "@/lib/env";
import { legalConfigurationStatus } from "@/lib/legal-documents";

/**
 * Définition unique de « les paiements sont ouverts » pour l'offre Analyse.
 *
 * Avant ce module, quatre lectures différentes coexistaient : `/api/billing/offer` ne regardait que
 * le Price, les métadonnées de `/offres` ajoutaient l'identité légale, le contrôle d'administration
 * ajoutait la clé secrète, l'URL et l'email, et le checkout lui-même n'en vérifiait qu'une partie
 * (sans le secret de webhook ni l'offre de lancement). Tout passe désormais par
 * `analysisCheckoutReadiness` :
 *
 * - la clé secrète Stripe, un Price récurrent valide et le secret de webhook (un encaissement sans
 *   webhook n'ouvrirait aucun accès : le client paierait sans rien recevoir) ;
 * - l'identité légale publiée (`NEXT_PUBLIC_LEGAL_*`) ;
 * - le canal de confirmation contractuelle (Resend, expéditeur, `SITE_URL`) ;
 * - l'offre de lancement coupée, quand l'appelant la connaît (`launchOfferActive`) : tant qu'elle
 *   dure, rien ne se souscrit, même si Stripe est configuré.
 *
 * Module sans accès à la base : l'état de l'offre de lancement est passé par l'appelant (le checkout
 * le lit dans `launch-offer.server.ts`). Les contrôles côté navigateur (`legalPublisherConfigurationStatus`)
 * ne font que restreindre ce résultat, jamais l'élargir.
 */
export type AnalysisCheckoutReadiness = {
  /** Vrai seulement si rien ne manque et que l'offre de lancement n'est pas active. */
  open: boolean;
  /** Variables d'environnement absentes ou invalides. */
  missing: string[];
  launchOfferActive: boolean;
};

const PRICE_ID_PATTERN = /^price_[A-Za-z0-9]+$/;

export function analysisCheckoutReadiness(
  env: Pick<NodeJS.ProcessEnv, string> = process.env,
  { launchOfferActive = false }: { launchOfferActive?: boolean } = {},
): AnalysisCheckoutReadiness {
  const config = serverEnv(env);
  const priceId = env.STRIPE_ANALYSIS_PRICE_ID?.trim();
  const missing = [
    ...(config.stripe.secretKey ? [] : ["STRIPE_SECRET_KEY"]),
    ...(priceId && PRICE_ID_PATTERN.test(priceId) ? [] : ["STRIPE_ANALYSIS_PRICE_ID"]),
    ...(config.stripe.webhookSecret ? [] : ["STRIPE_WEBHOOK_SECRET"]),
    ...legalConfigurationStatus(env).missing,
    ...resolveEmailAlertDeliveryConfig(env).missing,
  ];
  return {
    open: missing.length === 0 && !launchOfferActive,
    missing: Array.from(new Set(missing)),
    launchOfferActive,
  };
}

/** Lève une erreur claire quand le checkout ne doit pas s'ouvrir. */
export function assertAnalysisCheckoutOpen(
  env: Pick<NodeJS.ProcessEnv, string> = process.env,
  options: { launchOfferActive?: boolean } = {},
): void {
  const readiness = analysisCheckoutReadiness(env, options);
  if (readiness.launchOfferActive) {
    throw new Error(
      "L'abonnement Analyse n'est pas encore ouvert : l'offre de lancement est en cours. Le checkout est suspendu.",
    );
  }
  if (readiness.missing.length > 0) {
    throw new Error(
      `Configuration du paiement incomplète: ${readiness.missing.join(", ")}. Le checkout est suspendu.`,
    );
  }
}
