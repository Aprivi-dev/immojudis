import "server-only";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { ForbiddenError, NotFoundError } from "@/lib/api-errors";
import {
  featureIncluded,
  isPlanPeriodActive,
  isSaleUnlockFeature,
  isTrialExtensionRow,
  normalizePlanCode,
  pastDueGraceEnd,
  PLAN_LIMITS,
  type FeatureKey,
  type PlanBilling,
  type PlanEntitlements,
  type PlanStatus,
} from "@/lib/plans";
import { readSignupTrial } from "@/lib/launch-offer.server";
import { buildPlanEntitlements } from "@/lib/property-report/entitlements";
import { assertSalePublicationVisible } from "@/lib/sale-publication-guard";
import { hasUnlockedSale } from "@/lib/sale-unlocks.server";
import { DETAIL_VIEW, DISCOVERY_VIEW, UNLOCKED_VIEW } from "@/lib/sale-views";

/**
 * Résolution serveur des droits d'un compte (plan, essai, offre de lancement, administrateur), et
 * la porte qui ouvre un droit pour une vente (l'offre, ou le déblocage de cette vente). Les règles
 * d'accès Analyse ont un miroir SQL (`app_private.has_active_analysis_access`) :
 * `entitlements.server.parity.test.ts` rejoue les cas des tests pgTAP 740, 774, 775 et 850 contre
 * `resolvePlanEntitlements`.
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
    const admin = buildPlanEntitlements("analyse", null, ADMIN_PLAN_LIMITS);
    // Les clés d'API et la collaboration ne sont plus dans l'offre Analyse (n° 97) : l'administrateur
    // les garde.
    return {
      ...admin,
      features: {
        ...admin.features,
        salesApiAccess: "included",
        workspaceCollaboration: "included",
      },
    };
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

/** The door that opens a right for a sale: the offer itself, or the unlock of this very sale. */
export type SaleFeatureDoor = "plan" | "unlock";

/**
 * The one rule: the offer opens `feature` for every sale; otherwise an unlock opens the rights of
 * `SALE_UNLOCK_FEATURES`, for the sale the database confirms (unlocked and still online) only.
 */
async function doorFor(
  auth: SupabaseAuthContext,
  plan: PlanEntitlements,
  feature: FeatureKey,
  saleId: string | undefined,
): Promise<SaleFeatureDoor | null> {
  if (featureIncluded(plan.plan, feature)) return "plan";
  if (saleId && isSaleUnlockFeature(feature) && (await hasUnlockedSale(auth, saleId))) {
    return "unlock";
  }
  return null;
}

/**
 * Which door opens `feature` for this sale, or null when neither does. Routes that serve a teaser
 * to the other accounts use it to choose what they return (document reading, sale history).
 */
export async function saleFeatureDoor(
  auth: SupabaseAuthContext,
  feature: FeatureKey,
  saleId: string,
): Promise<SaleFeatureDoor | null> {
  return doorFor(auth, await resolvePlanEntitlements(auth), feature, saleId);
}

/**
 * Refuse a right the caller's offer does not include, and say which door opened it. With
 * `saleId`, an unlock of that sale opens the rights of `SALE_UNLOCK_FEATURES`, for that sale only.
 */
export async function assertFeatureEntitlementVia(
  auth: SupabaseAuthContext,
  feature: FeatureKey,
  message = "Fonctionnalité réservée à l’offre Analyse.",
  options: { saleId?: string } = {},
): Promise<{ plan: PlanEntitlements; door: SaleFeatureDoor }> {
  const plan = await resolvePlanEntitlements(auth);
  const door = await doorFor(auth, plan, feature, options.saleId);
  if (!door) throw new ForbiddenError(message);
  return { plan, door };
}

export async function assertFeatureEntitlement(
  auth: SupabaseAuthContext,
  feature: FeatureKey,
  message = "Fonctionnalité réservée à l’offre Analyse.",
  options: { saleId?: string } = {},
): Promise<PlanEntitlements> {
  return (await assertFeatureEntitlementVia(auth, feature, message, options)).plan;
}

/**
 * The catalogue view each door reads: the full one for the offer, the account's unlocked sales for
 * an unlock, the redacted one otherwise.
 */
const DOOR_VIEWS = {
  plan: DETAIL_VIEW,
  unlock: UNLOCKED_VIEW,
  none: DISCOVERY_VIEW,
} as const;

/**
 * Reads the sale as the caller sees it through `door` (its own session, so row-level security
 * applies), then the same publication check as the sale page for every door: an administrator's
 * session bypasses row-level security, and a quarantined sale must stay hidden all the same.
 * Absent or hidden: `NotFoundError`.
 */
export async function readSaleThroughDoor<Row = Record<string, unknown>>(
  auth: SupabaseAuthContext,
  saleId: string,
  door: SaleFeatureDoor | null,
  columns: string,
): Promise<Row> {
  const { data, error } = await auth.supabase
    .from(DOOR_VIEWS[door ?? "none"] as typeof DETAIL_VIEW)
    .select(columns)
    .eq("id", saleId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new NotFoundError("Vente introuvable.");
  await assertSalePublicationVisible(saleId);
  return data as Row;
}
