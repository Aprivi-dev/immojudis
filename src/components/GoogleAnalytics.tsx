"use client";

import Script from "next/script";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { usePublicPathname } from "@/hooks/use-public-pathname";
import {
  enableGoogleAnalytics,
  GTM_SCRIPT_URL,
  revokeGoogleAnalytics,
  sanitizeAnalyticsUrl,
  trackGooglePageView,
} from "@/lib/google-analytics";
import {
  getGoogleAnalyticsServerState,
  getGoogleAnalyticsState,
  subscribeGoogleAnalyticsState,
} from "@/lib/google-analytics-state";
import { whenIdle } from "@/lib/when-idle";

/**
 * Google Tag Manager et la balise Google Analytics qu'il porte, seulement après l'accord donné dans
 * le bandeau (`CookieConsentBanner`) ou sur la politique de confidentialité. Sans accord, aucun
 * script n'est chargé ni aucun cookie déposé ; au retrait de l'accord, les envois cessent et les
 * cookies sont effacés.
 *
 * Rendu une fois le navigateur inactif, et seulement après l'accord (`DeferredGoogleAnalytics`
 * n'importe même pas ce module sans accord, ni sur les pages exclues). Une page vue est envoyée à
 * chaque changement de chemin, avec une adresse nettoyée (`sanitizeAnalyticsUrl`).
 */
export function GoogleAnalytics() {
  const state = useSyncExternalStore(
    subscribeGoogleAnalyticsState,
    getGoogleAnalyticsState,
    getGoogleAnalyticsServerState,
  );
  const pathname = usePublicPathname();
  const lastLocation = useRef<string | null>(null);

  useEffect(() => {
    if (state !== "unset" && state !== "denied") return;
    revokeGoogleAnalytics();
    lastLocation.current = null;
  }, [state]);

  useEffect(() => {
    if (state !== "granted") return;
    enableGoogleAnalytics();
    // Lors d'une navigation interne, Next.js pose le titre de la nouvelle page après le changement
    // de chemin : la page vue part une fois le navigateur inactif, avec le bon titre.
    return whenIdle(() => {
      const origin = window.location.origin;
      const location = sanitizeAnalyticsUrl(window.location.href, origin);
      if (!location || location === lastLocation.current) return;
      const referrer =
        lastLocation.current ??
        (document.referrer ? sanitizeAnalyticsUrl(document.referrer, origin) : null);
      trackGooglePageView(location, referrer);
      lastLocation.current = location;
    }, 1_000);
  }, [state, pathname]);

  if (state !== "granted") return null;
  return <Script id="google-tag-manager" src={GTM_SCRIPT_URL} strategy="afterInteractive" />;
}
