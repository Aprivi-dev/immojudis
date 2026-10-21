"use client";

import { lazy, Suspense, useEffect, useState } from "react";
import { whenIdle } from "@/lib/when-idle";

// Chargés après l'affichage : hors du JavaScript commun à toutes les pages (budgets de build).
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
 */
export function DeferredGoogleAnalytics() {
  const [idle, setIdle] = useState(false);
  useEffect(() => whenIdle(() => setIdle(true)), []);
  if (!idle) return null;
  return (
    <Suspense fallback={null}>
      <GoogleAnalytics />
      <CookieConsentBanner />
    </Suspense>
  );
}
