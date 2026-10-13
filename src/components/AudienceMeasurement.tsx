"use client";

import { useSyncExternalStore } from "react";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { isAudienceOptedOut, subscribeAudienceOptOut } from "@/lib/audience-opt-out";

/** "pending" tant que le navigateur n'a pas été lu : rien n'est envoyé avant de connaître le choix. */
type MeasurementState = "pending" | "measured" | "opted-out";

function getSnapshot(): MeasurementState {
  return isAudienceOptedOut() ? "opted-out" : "measured";
}

function getServerSnapshot(): MeasurementState {
  return "pending";
}

/**
 * Vercel Analytics et Speed Insights, sauf si le visiteur s'y est opposé depuis la politique de
 * confidentialité. Ni l'un ni l'autre n'est rendu (donc aucun script chargé) avant d'avoir lu le
 * choix du navigateur ni une fois l'opposition activée. `beforeSend` couvre le cas d'un choix
 * fait pendant la visite, alors que les scripts sont déjà chargés : aucun envoi ne part ensuite.
 */
export function AudienceMeasurement() {
  const state = useSyncExternalStore(subscribeAudienceOptOut, getSnapshot, getServerSnapshot);
  if (state !== "measured") return null;
  return (
    <>
      <Analytics beforeSend={(event) => (isAudienceOptedOut() ? null : event)} />
      <SpeedInsights beforeSend={(event) => (isAudienceOptedOut() ? null : event)} />
    </>
  );
}
