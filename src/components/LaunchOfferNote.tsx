"use client";

import type { ReactNode } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useLaunchOffer } from "@/hooks/use-launch-offer";
import { launchOfferText } from "@/lib/launch-offer";

/**
 * Mention de l'offre de lancement pour les pages rendues côté serveur (comment ça marche,
 * simulateur…) : elle n'apparaît qu'une fois l'état lu dans la base, et seulement tant que l'offre
 * est active. Visiteur ou compte connecté : le texte correspondant (`src/lib/launch-offer.ts`).
 */
export function LaunchOfferNote({ className = "mt-4" }: { className?: string }) {
  const { user } = useAuth();
  const { active } = useLaunchOffer();
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
 * un compte connecté qui bénéficie déjà des avantages Analyse grâce à l'offre de lancement.
 */
export function HideForLaunchOfferAccount({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { active } = useLaunchOffer();
  return user && active ? null : <>{children}</>;
}
