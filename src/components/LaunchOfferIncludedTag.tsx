"use client";

import { useAccessPlan } from "@/hooks/use-access-plan";
import { useAuth } from "@/hooks/use-auth";
import { useLaunchOffer } from "@/hooks/use-launch-offer";

/**
 * Étiquette sobre « Inclus pendant votre essai gratuit » à côté de ce que l'offre Analyse ouvre
 * (enchère plafond, lecture des pièces). Montrée seulement à un compte en essai à l'inscription
 * (`plan.launchOffer`), jamais à un abonné réel ; elle disparaît avec la fin de l'essai. Les droits ne
 * sont lus que pendant l'offre de lancement.
 */
export function LaunchOfferIncludedTag({ className = "" }: { className?: string }) {
  const { user } = useAuth();
  const { active } = useLaunchOffer();
  const plan = useAccessPlan(active ? user?.id : null);
  if (!user || !active || plan?.launchOffer !== true) return null;
  return (
    <p className={className}>
      <span
        data-testid="launch-offer-included"
        className="inline-block rounded-full border border-gold/30 bg-gold/10 px-2.5 py-0.5 text-xs font-medium text-brand-navy"
      >
        Inclus pendant votre essai gratuit
      </span>
    </p>
  );
}
