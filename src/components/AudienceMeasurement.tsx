"use client";

import { lazy, Suspense, useEffect, useState, useSyncExternalStore } from "react";
import { isAudienceOptedOut, subscribeAudienceOptOut } from "@/lib/audience-opt-out";
import { isAnalyticsExcludedPath } from "@/lib/google-analytics-state";
import { whenIdle } from "@/lib/when-idle";

// Chargés après l'affichage (voir `AudienceMeasurement`) : hors du JavaScript commun.
const Analytics = lazy(() =>
  import("@vercel/analytics/next").then((module) => ({ default: module.Analytics })),
);
const SpeedInsights = lazy(() =>
  import("@vercel/speed-insights/next").then((module) => ({ default: module.SpeedInsights })),
);

/** "pending" tant que le navigateur n'a pas été lu : rien n'est envoyé avant de connaître le choix. */
type MeasurementState = "pending" | "measured" | "opted-out";

function getSnapshot(): MeasurementState {
  return isAudienceOptedOut() ? "opted-out" : "measured";
}

function getServerSnapshot(): MeasurementState {
  return "pending";
}

/**
 * Dernier filtre avant l'envoi : rien ne part si le visiteur s'est opposé à la mesure, ni depuis une
 * page de `ANALYTICS_EXCLUDED_PATHS` (la même liste que Google Analytics : espaces connectés,
 * administration, dépôt privé, droits, et `/auth/confirmer` dont l'adresse porte un jeton à usage
 * unique). Une adresse illisible n'est pas envoyée.
 */
function beforeSend<T extends { url: string }>(event: T): T | null {
  if (isAudienceOptedOut()) return null;
  try {
    return isAnalyticsExcludedPath(new URL(event.url, "https://immojudis.invalid").pathname)
      ? null
      : event;
  } catch {
    return null;
  }
}

/**
 * Vercel Analytics et Speed Insights, sauf si le visiteur s'y est opposé depuis la politique de
 * confidentialité. Ni l'un ni l'autre n'est rendu (donc aucun script chargé) avant d'avoir lu le
 * choix du navigateur ni une fois l'opposition activée. `beforeSend` couvre le cas d'un choix
 * fait pendant la visite, alors que les scripts sont déjà chargés : aucun envoi ne part ensuite.
 *
 * Les deux scripts ne sont chargés qu'une fois le navigateur inactif (au plus 2 s après
 * l'hydratation) pour ne pas concurrencer l'affichage. La page vue est mesurée au montage. À
 * vérifier sur le tableau de bord Speed Insights après déploiement : le script de mesure est
 * servi par Vercel (`/_vercel/speed-insights/script.js`) et son code n'est pas dans le dépôt.
 */
export function AudienceMeasurement() {
  const state = useSyncExternalStore(subscribeAudienceOptOut, getSnapshot, getServerSnapshot);
  const [idle, setIdle] = useState(false);
  useEffect(() => whenIdle(() => setIdle(true)), []);
  if (state !== "measured" || !idle) return null;
  return (
    <Suspense fallback={null}>
      <Analytics beforeSend={beforeSend} />
      <SpeedInsights beforeSend={beforeSend} />
    </Suspense>
  );
}
