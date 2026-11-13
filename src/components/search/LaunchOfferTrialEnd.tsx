"use client";

import Link from "next/link";
import { useAccessPlan } from "@/hooks/use-access-plan";
import { useAuth } from "@/hooks/use-auth";
import { signupTrialDateLabel } from "@/lib/launch-offer";

/**
 * Au-dessus de la liste des ventes, pour un compte en essai gratuit : la date de fin de son essai, en
 * une ligne factuelle. Ni compte à rebours, ni incitation à s'abonner (voir `AccountLaunchOfferEnd`).
 * La date est celle des droits du compte (`plan.trialEndsAt`) : la fin de l'essai, ou, si
 * l'administrateur l'a prolongé, la fin de la prolongation. Rien n'est montré avant que les droits
 * répondent.
 */
export function LaunchOfferTrialEnd() {
  const { user } = useAuth();
  const plan = useAccessPlan(user?.id);
  if (!user || plan?.launchOffer !== true || !plan.trialEndsAt) return null;
  return (
    <p
      role="note"
      data-testid="launch-offer-trial-end"
      className="mb-3 rounded-lg border border-gold/30 bg-gold/10 px-4 py-2 text-sm text-brand-navy"
    >
      {plan.trialExtension ? "Essai gratuit prolongé" : "Essai gratuit de l’offre Analyse"} jusqu’au{" "}
      {signupTrialDateLabel(plan.trialEndsAt)}.{" "}
      <Link href="/compte" className="font-semibold underline underline-offset-4">
        Détails dans Mon compte
      </Link>
    </p>
  );
}
