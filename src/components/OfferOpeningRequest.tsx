"use client";

import { useEffect, useState } from "react";
import Bell from "lucide-react/dist/esm/icons/bell.js";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useAuth } from "@/hooks/use-auth";
import {
  fetchOfferOpeningNotification,
  updateOfferOpeningNotification,
} from "@/lib/client-billing";
import { loginPathWithRedirect } from "@/lib/navigation";
import {
  OFFER_OPENING_CONSENT_TEXT,
  OFFER_OPENING_REQUESTED_TEXT,
} from "@/lib/offer-opening-consent";
import { trackProductEvent } from "@/lib/product-events";
import { userMessage } from "@/lib/user-messages";

/**
 * « Me prévenir de l'ouverture » : la demande explicite d'un email le jour où l'abonnement Analyse
 * ouvre. À monter seulement quand l'offre est fermée. Partagé par la page Offres (BillingActions)
 * et par les aperçus payants d'une vente quand les déblocages du mois sont épuisés.
 */
export function OfferOpeningRequest({ className = "mt-3" }: { className?: string }) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const userId = user?.id ?? null;
  const [openingRequested, setOpeningRequested] = useState<boolean | null>(null);
  const [openingBusy, setOpeningBusy] = useState(false);

  useEffect(() => {
    if (!userId) return;
    let active = true;
    fetchOfferOpeningNotification()
      .then((response) => {
        if (active) setOpeningRequested(response.notification.requested);
      })
      .catch(() => {
        if (active) setOpeningRequested(null);
      });
    return () => {
      active = false;
    };
  }, [userId]);

  async function changeOpeningRequest(enabled: boolean) {
    if (openingBusy) return;
    if (!user) {
      router.push(loginPathWithRedirect("/offres", { reason: "offre" }));
      return;
    }
    setOpeningBusy(true);
    try {
      const response = await updateOfferOpeningNotification(enabled);
      setOpeningRequested(response.notification.requested);
      if (enabled && response.notification.requested) {
        trackProductEvent("opening_notification_requested");
      }
    } catch (error) {
      toast.error(userMessage(error, "Demande impossible"));
    } finally {
      setOpeningBusy(false);
    }
  }

  if (openingRequested) {
    return (
      <p role="status" className={`${className} font-medium`}>
        {OFFER_OPENING_REQUESTED_TEXT}{" "}
        <button
          type="button"
          onClick={() => changeOpeningRequest(false)}
          disabled={openingBusy}
          className="font-semibold underline disabled:opacity-60"
        >
          Retirer ma demande
        </button>
      </p>
    );
  }

  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => changeOpeningRequest(true)}
        disabled={openingBusy || loading}
        className="ij-login-button inline-flex w-full items-center justify-center gap-2 px-4 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60"
      >
        <Bell className="h-4 w-4" aria-hidden />
        Me prévenir de l’ouverture
      </button>
      <p className="mt-2 text-xs text-muted-foreground">
        {user
          ? OFFER_OPENING_CONSENT_TEXT
          : "Un compte gratuit est nécessaire pour être prévenu : vous serez invité à le créer."}
      </p>
    </div>
  );
}
