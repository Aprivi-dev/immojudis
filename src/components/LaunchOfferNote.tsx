"use client";

import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useLaunchOffer } from "@/hooks/use-launch-offer";
import { fetchAccessPlan } from "@/lib/client-billing";
import { launchOfferText } from "@/lib/launch-offer";
import * as queryKeys from "@/lib/query-keys";

/**
 * Mention de l'essai gratuit à l'inscription pour les pages rendues côté serveur (comment ça marche,
 * simulateur…) : elle n'apparaît qu'une fois l'état lu dans la base, et seulement tant que l'essai
 * est ouvert. Visiteur ou compte connecté : le texte correspondant (`src/lib/launch-offer.ts`).
 *
 * Tant que l'état n'est pas lu, une hauteur est réservée (vide, masquée aux lecteurs d'écran) :
 * sans elle, le bloc insérait une soixantaine de pixels sous le titre (décalage de mise en page).
 * Hauteurs approximatives (texte sur 6 lignes sur mobile, 3 au-delà). Le bloc lui-même n'est jamais
 * rendu côté serveur : la coupure de l'offre doit se voir en moins de 60 s.
 */
export function LaunchOfferNote({ className = "mt-4" }: { className?: string }) {
  const { user } = useAuth();
  const { active, pending } = useLaunchOffer();
  if (pending) {
    return (
      <div
        aria-hidden
        data-testid="launch-offer-note-placeholder"
        className={`${className} min-h-40 sm:min-h-24`}
      />
    );
  }
  if (!active) return null;
  return (
    <p
      role="note"
      data-testid="launch-offer-note"
      className={`${className} rounded-lg border border-gold/30 bg-gold/10 px-4 py-3 text-sm font-medium leading-relaxed text-brand-navy`}
    >
      {launchOfferText(user ? "account" : "visitor")}
    </p>
  );
}

/**
 * Une incitation à « découvrir l'offre Analyse » (page rendue côté serveur) : montrée à tous, sauf à
 * un compte connecté en essai gratuit (`plan.launchOffer`), qui a déjà l'offre Analyse. Un compte dont
 * l'essai est fini la revoit. Même requête de plan que les autres écrans (clé partagée).
 */
export function HideForLaunchOfferAccount({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { active } = useLaunchOffer();
  const { data } = useQuery({
    queryKey: queryKeys.featureEntitlementsPlan(user?.id ?? "anonymous"),
    queryFn: fetchAccessPlan,
    enabled: Boolean(user && active),
    staleTime: 5 * 60_000,
    retry: false,
  });
  return user && active && data?.plan.launchOffer === true ? null : <>{children}</>;
}
