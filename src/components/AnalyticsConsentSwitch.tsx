"use client";

import { useId, useSyncExternalStore } from "react";
import {
  readAnalyticsConsent,
  setAnalyticsConsent,
  subscribeAnalyticsConsent,
} from "@/lib/analytics-consent";
import { isAudienceOptedOut, subscribeAudienceOptOut } from "@/lib/audience-opt-out";

/**
 * Accord aux cookies de Google Analytics, propre à ce navigateur : le même choix que le bandeau
 * (`CookieConsentBanner`), modifiable à tout moment. Le serveur affiche « aucun accord » ; le
 * navigateur relit son choix à l'hydratation. Tant que l'opposition à la mesure d'audience est
 * active, Google Analytics reste coupé et la case est désactivée.
 */
export function AnalyticsConsentSwitch() {
  const statusId = useId();
  const consent = useSyncExternalStore(subscribeAnalyticsConsent, readAnalyticsConsent, () => null);
  const optedOut = useSyncExternalStore(subscribeAudienceOptOut, isAudienceOptedOut, () => false);
  const granted = consent === "granted" && !optedOut;

  return (
    <div className="mt-3 rounded-lg border border-white/10 bg-black/10 p-3">
      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          role="switch"
          checked={granted}
          disabled={optedOut}
          aria-describedby={statusId}
          onChange={(event) => setAnalyticsConsent(event.target.checked ? "granted" : "denied")}
          className="mt-0.5 h-4 w-4 shrink-0"
        />
        <span className="font-semibold text-foreground">
          J’accepte les cookies de Google Analytics sur ce navigateur
        </span>
      </label>
      <p id={statusId} role="status" className="mt-2 text-xs">
        {optedOut
          ? "Vous avez coché « Je m’oppose à la mesure d’audience » : Google Analytics n’est pas chargé. Décochez cette autre case pour pouvoir donner votre accord."
          : granted
            ? "Accord enregistré dans ce navigateur pour 6 mois. Décochez la case pour le retirer : Google Analytics ne reçoit plus rien et ses cookies sont effacés de ce navigateur."
            : "Aucun accord : Google Analytics n’est pas chargé et ne dépose aucun cookie. Cochez la case pour l’accepter ; votre choix est mémorisé 6 mois dans ce navigateur."}
      </p>
    </div>
  );
}
