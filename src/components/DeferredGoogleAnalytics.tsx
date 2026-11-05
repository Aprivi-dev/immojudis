"use client";

import { lazy, Suspense, useEffect, useState, useSyncExternalStore } from "react";
import { usePublicPathname } from "@/hooks/use-public-pathname";
import {
  getGoogleAnalyticsServerState,
  getGoogleAnalyticsState,
  googleAnalyticsMayBeActive,
  isAnalyticsExcludedPath,
  subscribeGoogleAnalyticsState,
} from "@/lib/google-analytics-state";
import { whenIdle } from "@/lib/when-idle";

// Chargés après l'affichage : hors du JavaScript commun à toutes les pages (budgets de build).
// Le module de la balise n'est demandé qu'après un accord ; le bandeau, tant qu'aucun choix n'est
// en cours de validité.
const GoogleAnalytics = lazy(() =>
  import("./GoogleAnalytics").then((module) => ({ default: module.GoogleAnalytics })),
);
const CookieConsentBanner = lazy(() =>
  import("./CookieConsentBanner").then((module) => ({ default: module.CookieConsentBanner })),
);

/**
 * Google Analytics et son bandeau de consentement, chargés une fois le navigateur inactif (au plus
 * 2 s après l'hydratation), comme Vercel Analytics : ni l'un ni l'autre ne concurrence l'affichage.
 * Le bandeau, en surimpression, ne décale pas la page.
 *
 * - Sans accord (`unset`, `denied`), le module de la balise n'est jamais importé, sauf pour effacer
 *   ce qu'un accord précédent aurait laissé (balise chargée, cookies `_ga`) ;
 * - ni la balise ni le bandeau ne sont montés sur les pages de `ANALYTICS_EXCLUDED_PATHS` ; si la
 *   balise est déjà chargée, ses envois sont suspendus le temps de la visite de ces pages ;
 * - la balise ne se charge que sur le site en production (`immojudis.com`, où `www` redirige) : ni le
 *   poste de développement (`localhost`, `127.0.0.1`) ni les préversions Vercel ne mêlent leurs visites
 *   de test aux chiffres. Le bandeau reste affiché partout, pour qu'on puisse le relire avant une mise
 *   en ligne. Seul le build des tests de bout en bout (`playwright.config.ts`) lève cette limite avec
 *   `NEXT_PUBLIC_ANALYTICS_ANY_HOST=1` : ses tests interceptent GTM, rien ne sort du poste. Ailleurs, la
 *   variable est absente et Next.js la remplace par une constante, que la minification élimine.
 */
export function DeferredGoogleAnalytics() {
  const [idle, setIdle] = useState(false);
  const state = useSyncExternalStore(
    subscribeGoogleAnalyticsState,
    getGoogleAnalyticsState,
    getGoogleAnalyticsServerState,
  );
  const excluded = isAnalyticsExcludedPath(usePublicPathname());
  useEffect(() => whenIdle(() => setIdle(true)), []);

  useEffect(() => {
    if (!idle || !googleAnalyticsMayBeActive()) return;
    if (state === "unset" || state === "denied") {
      void import("@/lib/google-analytics").then((module) => module.revokeGoogleAnalytics());
    } else if (state === "granted" && excluded) {
      void import("@/lib/google-analytics").then((module) => {
        // La personne a pu quitter la page exclue pendant le chargement du module.
        if (isAnalyticsExcludedPath(window.location.pathname)) module.suspendGoogleAnalytics();
      });
    }
  }, [excluded, idle, state]);

  if (!idle || excluded) return null;
  return (
    <Suspense fallback={null}>
      {state === "granted" &&
      (location.hostname === "immojudis.com" ||
        process.env.NEXT_PUBLIC_ANALYTICS_ANY_HOST === "1") ? (
        <GoogleAnalytics />
      ) : null}
      {state === "unset" ? <CookieConsentBanner /> : null}
    </Suspense>
  );
}
