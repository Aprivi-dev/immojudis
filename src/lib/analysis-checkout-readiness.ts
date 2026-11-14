import { resolveEmailAlertDeliveryConfig } from "@/lib/email-alerts";
import { serverEnv } from "@/lib/env";
import { legalConfigurationStatus } from "@/lib/legal-documents";
import { ConfigurationError, PublicApiError } from "@/lib/api-errors";

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
 * - une clé du mode attendu par le déploiement (C3, 14/11) : réel en production Vercel, test en
 *   preview ou en développement. Une clé de test en production ferait obtenir Analyse avec la carte
 *   de test de Stripe, sans payer ; une clé réelle sur un preview encaisserait de vrais paiements
 *   sur une base de test ;
 * - l'identité légale publiée (`NEXT_PUBLIC_LEGAL_*`) ;
 * - le canal de confirmation contractuelle (Resend, expéditeur, `SITE_URL`) ;
 * - l'interrupteur de vente `STRIPE_ANALYSIS_SALES_OPEN` (C2, 14/11) : il ferme le checkout sans
 *   toucher au Price reconnu (`isRecognisedAnalysisPrice`) ni au rapprochement
 *   (`billingReconciliationConfigured`), qui lisent `STRIPE_ANALYSIS_PRICE_ID` et non cette
 *   garde. Les abonnés en cours gardent donc leur accès et leurs renouvellements.
 *
 * L'essai gratuit de 7 jours à l'inscription (l'interrupteur de l'offre de lancement) n'y entre
 * pas depuis le 25/10/2026 : un compte peut s'abonner pendant ou après son essai. Module sans accès
 * à la base. Les contrôles côté navigateur (`legalPublisherConfigurationStatus`) ne font que
 * restreindre ce résultat, jamais l'élargir.
 */
export type AnalysisCheckoutReadiness = {
  /** Vrai seulement si rien ne manque, si la clé est du bon mode et si la vente est ouverte. */
  open: boolean;
  /** Variables d'environnement absentes ou invalides. */
  missing: string[];
  /** La clé Stripe n'est pas du mode attendu par ce déploiement (voir `expectedStripeKeyMode`). */
  keyModeMismatch: boolean;
  /** La vente est fermée par `STRIPE_ANALYSIS_SALES_OPEN`, que la configuration soit complète ou non. */
  salesClosed: boolean;
};

export type StripeKeyMode = "live" | "test";

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

/**
 * Mode d'une clé secrète Stripe d'après son préfixe : `sk_live_` et `rk_live_` (clé restreinte) en
 * réel, `sk_test_` et `rk_test_` en test. `null` pour une valeur absente ou d'une autre forme. Même
 * règle que `stripeKeyMode` de `scripts/lib/launch-config.mjs` (testé).
 */
export function stripeKeyMode(key: string | null | undefined): StripeKeyMode | null {
  const match = /^[sr]k_(live|test)_/.exec(key?.trim() ?? "");
  return match ? (match[1] as StripeKeyMode) : null;
}

/**
 * Mode attendu par le déploiement, lu dans `VERCEL_ENV` à l'exécution : réel en production, test en
 * preview et en développement. `null` hors Vercel (poste local, CI) : rien à comparer.
 */
function expectedStripeKeyMode(env: Pick<NodeJS.ProcessEnv, string>): StripeKeyMode | null {
  const vercelEnv = env.VERCEL_ENV?.trim();
  if (vercelEnv === "production") return "live";
  if (vercelEnv === "preview" || vercelEnv === "development") return "test";
  return null;
}

/**
 * La vente est-elle ouverte selon `STRIPE_ANALYSIS_SALES_OPEN` ? Absente ou vide : ouverte, pour que
 * le déploiement de cet interrupteur ne ferme pas la production, qui vend déjà sans lui. Posée, seule
 * la valeur `true` garde la vente ouverte : `false`, mais aussi `0`, `non` ou une faute de frappe la
 * ferment, puisque poser la variable sert à fermer.
 */
function analysisSalesOpen(env: Pick<NodeJS.ProcessEnv, string>): boolean {
  const value = serverEnv(env).stripe.analysisSalesOpen?.toLowerCase();
  return !value || value === "true";
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
  const keyMode = stripeKeyMode(config.stripe.secretKey);
  const expectedMode = expectedStripeKeyMode(env);
  const keyModeMismatch = Boolean(keyMode && expectedMode && keyMode !== expectedMode);
  const salesClosed = !analysisSalesOpen(env);
  return {
    open: missing.length === 0 && !keyModeMismatch && !salesClosed,
    missing: Array.from(new Set(missing)),
    keyModeMismatch,
    salesClosed,
  };
}

/** Lève une erreur claire quand le checkout ne doit pas s'ouvrir. */
export function assertAnalysisCheckoutOpen(
  env: Pick<NodeJS.ProcessEnv, string> = process.env,
): void {
  const readiness = analysisCheckoutReadiness(env);
  const problems = [
    ...readiness.missing,
    ...(readiness.keyModeMismatch
      ? ["STRIPE_SECRET_KEY (mode de la clé différent de celui du déploiement)"]
      : []),
  ];
  if (problems.length > 0) {
    throw new ConfigurationError(
      `Configuration du paiement incomplète: ${problems.join(", ")}. Le checkout est suspendu.`,
    );
  }
  if (readiness.salesClosed) {
    throw new PublicApiError("La souscription à l’offre Analyse est momentanément fermée.", 503);
  }
}
