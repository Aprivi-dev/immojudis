import "server-only";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import {
  isPlanPeriodActive,
  isTrialExtensionRow,
  normalizePlanCode,
  pastDueGraceEnd,
  PLAN_LIMITS,
  type PlanBilling,
  type PlanStatus,
} from "@/lib/plans";
import { readSignupTrial } from "@/lib/launch-offer.server";
import type { PlanEntitlements } from "@/lib/property-reports";
import { buildPlanEntitlements } from "@/lib/property-report/entitlements";

/**
 * Résolution serveur des droits d'un compte (plan, essai, offre de lancement, administrateur).
 * Déplacée depuis `property-reports.ts` sans changement de comportement. Les règles d'accès Analyse
 * ont un miroir SQL (`app_private.has_active_analysis_access`) : `entitlements.server.parity.test.ts`
 * rejoue les cas des tests pgTAP 740, 774 et 775 contre cette fonction.
 */

const ADMIN_PLAN_LIMITS: PlanEntitlements["limits"] = {
  propertyReportsPerMonth: null,
  pdfExportsPerMonth: null,
  savedReports: null,
  reportEditing: "full",
  favoriteSales: null,
  monthlyUnlocks: null,
  watchedZones: null,
  saleAnalysisSets: null,
  saleAnalysisItems: null,
  apiKeys: null,
  workspaceCollaborators: null,
};

export async function resolvePlanEntitlements(
  auth: SupabaseAuthContext,
): Promise<PlanEntitlements> {
  if (auth.isAdmin) {
    return buildPlanEntitlements("analyse", null, ADMIN_PLAN_LIMITS);
  }
  if (auth.accountTier === "premium") {
    return buildPlanEntitlements("analyse", null);
  }

  const { data, error } = await auth.supabase
    .from("user_subscriptions")
    .select(
      "plan_code,status,current_period_end,stripe_customer_id,stripe_subscription_id,metadata",
    )
    .eq("user_id", auth.userId)
    .maybeSingle();

  if (error) throw error;
  const planActive = Boolean(data && isPlanPeriodActive(data.status, data.current_period_end));
  const plan = data && planActive ? normalizePlanCode(data.plan_code) : "decouverte";
  // Prolongation d'essai par l'administrateur (ligne sans abonnement Stripe) : c'est un essai, pas un
  // abonnement. Même règle que `app_private.is_admin_trial_extension` (migration 20261108130000).
  const extension = isTrialExtensionRow(data);
  if (data && extension && planActive && plan === "analyse") {
    return buildPlanEntitlements(
      "analyse",
      data.current_period_end,
      PLAN_LIMITS.analyse,
      // Pas de portail ni de résiliation : un éventuel client Stripe (checkout abandonné) n'est pas
      // un abonnement à gérer.
      { status: data.status as PlanStatus, hasStripeCustomer: false, graceEndsAt: null },
      { launchOffer: true, trialEndsAt: data.current_period_end, trialExtension: true },
    );
  }
  const extensionEndedAt = data && extension && !planActive ? data.current_period_end : null;
  const billing: PlanBilling = {
    status: (data?.status as PlanStatus | undefined) ?? null,
    hasStripeCustomer: Boolean(data?.stripe_customer_id),
    graceEndsAt: data?.status === "past_due" ? pastDueGraceEnd(data.current_period_end) : null,
  };
  // Essai gratuit de 7 jours à l'inscription : pendant son essai, un compte gratuit qui a un
  // profil reçoit l’offre Analyse, avec ses quotas (rapports, PDF, actualisations). L'état vient de
  // la base, comme pour les fonctions SQL d'accès (`app_private.has_active_analysis_access`) ; rien
  // n'est écrit sur le compte, la fin de l'essai ramène donc le plan Découverte sans nettoyage.
  if (plan === "decouverte" && auth.hasProfile !== false) {
    // Essai lu dans la base (`app_private.signup_trial_ends_at`) : email confirmé, non jetable, plus
    // ancien compte confirmé de son adresse canonique, 7 jours après la confirmation. La lecture
    // applique aussi l'interrupteur : couper l'essai ne ferme que les nouveaux essais.
    const trial = await readSignupTrial(auth.userId);
    if (trial.active) {
      return buildPlanEntitlements(
        "analyse",
        data?.current_period_end ?? null,
        PLAN_LIMITS.analyse,
        billing,
        { launchOffer: true, trialEndsAt: trial.endsAt },
      );
    }
    // Fin de l'essai : la plus tardive de la fin naturelle et de la fin d'une prolongation échue.
    const endedAt = latestIso(trial.endsAt, extensionEndedAt);
    if (endedAt || trial.denied) {
      return buildPlanEntitlements(
        plan,
        data?.current_period_end ?? null,
        PLAN_LIMITS[plan],
        billing,
        { trialEndedAt: endedAt, trialDenied: !endedAt && trial.denied === true },
      );
    }
  }
  return buildPlanEntitlements(plan, data?.current_period_end ?? null, PLAN_LIMITS[plan], billing);
}

function latestIso(...values: Array<string | null | undefined>): string | null {
  let latest: string | null = null;
  for (const value of values) {
    if (!value || !Number.isFinite(Date.parse(value))) continue;
    if (latest === null || Date.parse(value) > Date.parse(latest)) latest = value;
  }
  return latest;
}
