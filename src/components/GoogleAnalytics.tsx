"use client";

import Script from "next/script";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { usePublicPathname } from "@/hooks/use-public-pathname";
import {
  enableGoogleAnalytics,
  GA_SCRIPT_URL,
  getGoogleAnalyticsServerState,
  getGoogleAnalyticsState,
  revokeGoogleAnalytics,
  sanitizeAnalyticsUrl,
  subscribeGoogleAnalyticsState,
  trackGooglePageView,
} from "@/lib/google-analytics";
import { whenIdle } from "@/lib/when-idle";

/**
 * Google Analytics, seulement après l'accord donné dans le bandeau (`CookieConsentBanner`) ou sur
 * la politique de confidentialité. Sans accord, aucun script n'est chargé ni aucun cookie déposé ;
 * au retrait de l'accord, les envois cessent et les cookies sont effacés.
 *
 * Comme Vercel Analytics, la balise n'est chargée qu'une fois le navigateur inactif. Une page vue
 * est envoyée à chaque changement de chemin, avec une adresse nettoyée (`sanitizeAnalyticsUrl`).
 */
export function GoogleAnalytics() {
  const state = useSyncExternalStore(
    subscribeGoogleAnalyticsState,
    getGoogleAnalyticsState,
    getGoogleAnalyticsServerState,
  );
  const pathname = usePublicPathname();
  const [idle, setIdle] = useState(false);
  const lastLocation = useRef<string | null>(null);

  useEffect(() => whenIdle(() => setIdle(true)), []);

  useEffect(() => {
    if (state !== "unset" && state !== "denied") return;
    revokeGoogleAnalytics();
    lastLocation.current = null;
  }, [state]);

  useEffect(() => {
    if (state !== "granted" || !idle) return;
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
  }, [state, idle, pathname]);

  if (state !== "granted" || !idle) return null;
  return <Script id="google-analytics" src={GA_SCRIPT_URL} strategy="afterInteractive" />;
}
