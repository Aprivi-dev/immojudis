"use client";

import { useId, useSyncExternalStore } from "react";
import {
  isAudienceOptedOut,
  setAudienceOptOut,
  subscribeAudienceOptOut,
} from "@/lib/audience-opt-out";

/**
 * Interrupteur d'opposition à la mesure d'audience (Vercel Analytics, Speed Insights et
 * événements de parcours), propre à ce navigateur. Le serveur affiche « mesure active » ; le
 * navigateur relit son choix à l'hydratation.
 */
export function AudienceOptOutSwitch() {
  const statusId = useId();
  const optedOut = useSyncExternalStore(subscribeAudienceOptOut, isAudienceOptedOut, () => false);

  return (
    <div className="mt-3 rounded-lg border border-white/10 bg-black/10 p-3">
      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          role="switch"
          checked={optedOut}
          aria-describedby={statusId}
          onChange={(event) => setAudienceOptOut(event.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0"
        />
        <span className="font-semibold text-foreground">
          Je m’oppose à la mesure d’audience sur ce navigateur
        </span>
      </label>
      <p id={statusId} role="status" className="mt-2 text-xs">
        {optedOut
          ? "Opposition enregistrée dans ce navigateur : plus aucune donnée de mesure n’est envoyée. Vous pouvez la retirer à tout moment en décochant cette case."
          : "Mesure d’audience active. Cochez la case pour vous y opposer ; votre choix est mémorisé dans ce navigateur (effacer les données du site le retire)."}
      </p>
    </div>
  );
}
