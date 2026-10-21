"use client";

import Link from "next/link";
import { useId, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/primitives";
import { setAnalyticsConsent } from "@/lib/analytics-consent";
import {
  getGoogleAnalyticsServerState,
  getGoogleAnalyticsState,
  subscribeGoogleAnalyticsState,
} from "@/lib/google-analytics";

/**
 * Demande d'accord aux cookies de Google Analytics, tant qu'aucun choix n'est en cours de validité.
 * Refuser est aussi simple qu'accepter (deux boutons identiques) et le bandeau ne bloque pas la
 * navigation : sans réponse, rien n'est chargé. Le choix se modifie à tout moment sur la politique
 * de confidentialité (lien « Gérer les cookies » du pied de page).
 *
 * Rendu une fois le navigateur inactif (`DeferredGoogleAnalytics`), en surimpression : il ne
 * décale pas la page et ne concurrence pas l'affichage du contenu.
 */
export function CookieConsentBanner() {
  const state = useSyncExternalStore(
    subscribeGoogleAnalyticsState,
    getGoogleAnalyticsState,
    getGoogleAnalyticsServerState,
  );
  const headingId = useId();

  if (state !== "unset") return null;
  return (
    <section
      aria-labelledby={headingId}
      // La bande pleine largeur laisse passer les clics : seule la carte les reçoit.
      className="pointer-events-none fixed inset-x-0 bottom-0 z-50 p-3 sm:p-4"
      data-testid="cookie-consent-banner"
    >
      <div className="pointer-events-auto mx-auto flex max-w-3xl flex-col gap-3 rounded-lg border border-border bg-white p-4 text-sm text-muted-foreground shadow-[0_-12px_32px_rgba(15,23,42,0.14)] sm:flex-row sm:items-center sm:gap-5">
        <div className="flex-1">
          <h2 id={headingId} className="font-semibold text-foreground">
            Cookies de mesure d’audience
          </h2>
          <p className="mt-1">
            Nous mesurons déjà la fréquentation sans cookie. Avec votre accord, Google Analytics
            dépose aussi des cookies pour nous aider à comprendre l’usage du site, sans publicité.{" "}
            <Link
              href="/privacy#cookies"
              className="font-semibold text-gold-text underline underline-offset-4"
            >
              En savoir plus
            </Link>
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-col">
          <Button onClick={() => setAnalyticsConsent("denied")}>Refuser</Button>
          <Button onClick={() => setAnalyticsConsent("granted")}>Accepter</Button>
        </div>
      </div>
    </section>
  );
}
