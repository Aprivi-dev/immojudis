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

const PRICE_ID_PATTERN = /^price_[A-Za-z0-9]+$/;

export function analysisCheckoutReadiness(
  env: Pick<NodeJS.ProcessEnv, string> = process.env,
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
    throw new Error(
      `Configuration du paiement incomplète: ${readiness.missing.join(", ")}. Le checkout est suspendu.`,
    );
  }
}
