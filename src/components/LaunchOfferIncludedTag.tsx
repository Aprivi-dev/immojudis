"use client";

import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { useLaunchOffer } from "@/hooks/use-launch-offer";
import { fetchAccessPlan } from "@/lib/client-billing";
import { queryKeys } from "@/lib/query-keys";

/**
 * Étiquette sobre « Inclus pendant votre essai gratuit » à côté de ce que l'offre Analyse ouvre
 * (enchère plafond, lecture des pièces). Montrée seulement à un compte en essai à l'inscription
 * (`plan.launchOffer`), jamais à un abonné réel ; elle disparaît avec la fin de l'essai. Même requête
 * de plan que les autres écrans (clé partagée), donc aucune lecture de plus.
 */
export function LaunchOfferIncludedTag({ className = "" }: { className?: string }) {
  const { user } = useAuth();
  const { active } = useLaunchOffer();
  const { data } = useQuery({
    queryKey: queryKeys.featureEntitlementsPlan(user?.id ?? "anonymous"),
    queryFn: fetchAccessPlan,
    enabled: Boolean(user && active),
    staleTime: 5 * 60_000,
    retry: false,
  });
  if (!user || !active || data?.plan.launchOffer !== true) return null;
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
