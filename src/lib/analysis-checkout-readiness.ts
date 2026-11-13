import { resolveEmailAlertDeliveryConfig } from "@/lib/email-alerts";
import { serverEnv } from "@/lib/env";
import { legalConfigurationStatus } from "@/lib/legal-documents";
import { ConfigurationError } from "@/lib/api-errors";

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
 * - le canal de confirmation contractuelle (Resend, expéditeur, `SITE_URL`).
 *
 * L'essai gratuit de 7 jours à l'inscription (l'interrupteur de l'offre de lancement) n'y entre
 * pas depuis le 25/10/2026 : un compte peut s'abonner pendant ou après son essai. Module sans accès
 * à la base. Les contrôles côté navigateur (`legalPublisherConfigurationStatus`) ne font que
 * restreindre ce résultat, jamais l'élargir.
 */
export type AnalysisCheckoutReadiness = {
  /** Vrai seulement si rien ne manque. */
  open: boolean;
  /** Variables d'environnement absentes ou invalides. */
  missing: string[];
};

/**
 * Price des nouveaux abonnements Analyse (`STRIPE_ANALYSIS_PRICE_ID`) s'il a la forme d'un Price
 * Stripe (`price_…`) ; `undefined` s'il est absent ou mal formé. Seule lecture de la variable pour
 * le checkout et pour l'ouverture des paiements.
 */
export function analysisPriceId(
  env: Pick<NodeJS.ProcessEnv, string> = process.env,
): string | undefined {
  const priceId = serverEnv(env).stripe.analysisPriceId;
  return priceId && /^price_[A-Za-z0-9]+$/.test(priceId) ? priceId : undefined;
}

export function analysisCheckoutReadiness(
  env: Pick<NodeJS.ProcessEnv, string> = process.env,
): AnalysisCheckoutReadiness {
  const config = serverEnv(env);
  const missing = [
    ...(config.stripe.secretKey ? [] : ["STRIPE_SECRET_KEY"]),
    ...(analysisPriceId(env) ? [] : ["STRIPE_ANALYSIS_PRICE_ID"]),
    ...(config.stripe.webhookSecret ? [] : ["STRIPE_WEBHOOK_SECRET"]),
    ...legalConfigurationStatus(env).missing,
    ...resolveEmailAlertDeliveryConfig(env).missing,
  ];
  return {
    open: missing.length === 0,
    missing: Array.from(new Set(missing)),
  };
}

/** Lève une erreur claire quand le checkout ne doit pas s'ouvrir. */
export function assertAnalysisCheckoutOpen(
  env: Pick<NodeJS.ProcessEnv, string> = process.env,
): void {
  const readiness = analysisCheckoutReadiness(env);
  if (readiness.missing.length > 0) {
    throw new ConfigurationError(
      `Configuration du paiement incomplète: ${readiness.missing.join(", ")}. Le checkout est suspendu.`,
    );
  }
}
