"use client";

import { useEffect, useRef, useState } from "react";
import Bell from "lucide-react/dist/esm/icons/bell.js";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { OfferOpeningSurvey } from "@/components/OfferOpeningSurvey";
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
import type { OfferOpeningSurveyState } from "@/lib/offer-opening-notification";
import { trackProductEvent } from "@/lib/product-events";
import { userMessage } from "@/lib/user-messages";

/**
 * Paramètre ajouté à l'adresse de retour de la connexion (motif `ouverture`) : au retour, la
 * demande cliquée avant la création du compte est enregistrée, puis le paramètre est retiré.
 */
export const OPENING_REQUEST_PARAM = "demande";
export const OPENING_REQUEST_VALUE = "ouverture";
const OPENING_RETURN_PATH = `/offres?${OPENING_REQUEST_PARAM}=${OPENING_REQUEST_VALUE}`;

/** Texte sous le bouton d'un visiteur : le consentement, puis le compte à créer. */
const ANONYMOUS_HELP = `${OFFER_OPENING_CONSENT_TEXT} Un compte gratuit est nécessaire : vous serez invité à le créer, et votre demande sera enregistrée à votre retour.`;

/**
 * « Me prévenir de l'ouverture » : la demande explicite d'un email le jour où l'abonnement Analyse
 * ouvre. À monter seulement quand l'offre est fermée. Partagé par la page Offres (BillingActions)
 * et par les aperçus payants d'une vente quand les déblocages du mois sont épuisés.
 *
 * Une fois la demande enregistrée, trois questions facultatives et une case « entretien de
 * 20 minutes » (non cochée) sont proposées (`OfferOpeningSurvey`). `primary` : le bouton est l'action
 * principale de la zone (offre fermée sur /offres) et non un lien discret.
 */
export function OfferOpeningRequest({
  className = "mt-3",
  primary = false,
}: {
  className?: string;
  primary?: boolean;
}) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const userId = user?.id ?? null;
  const [openingRequested, setOpeningRequested] = useState<boolean | null>(null);
  const [survey, setSurvey] = useState<OfferOpeningSurveyState | null>(null);
  const [openingBusy, setOpeningBusy] = useState(false);
  const resumed = useRef(false);

  async function changeOpeningRequest(enabled: boolean) {
    if (openingBusy) return;
    if (!user) {
      // Motif « ouverture » : la demande est enregistrée au retour, une fois le compte créé.
      router.push(loginPathWithRedirect(OPENING_RETURN_PATH, { reason: "ouverture" }));
      return;
    }
    setOpeningBusy(true);
    try {
      const response = await updateOfferOpeningNotification(enabled);
      setOpeningRequested(response.notification.requested);
      setSurvey(response.notification.survey ?? null);
      if (enabled && response.notification.requested) {
        trackProductEvent("opening_notification_requested");
      }
    } catch (error) {
      toast.error(userMessage(error, "Demande impossible"));
    } finally {
      setOpeningBusy(false);
    }
  }

  useEffect(() => {
    if (!userId) return;
    let active = true;
    fetchOfferOpeningNotification()
      .then((response) => {
        if (!active) return;
        setOpeningRequested(response.notification.requested);
        setSurvey(response.notification.survey ?? null);
        // Retour de la connexion après un clic sur « Me prévenir » : on enregistre la demande.
        const params = new URLSearchParams(window.location.search);
        if (params.get(OPENING_REQUEST_PARAM) === OPENING_REQUEST_VALUE && !resumed.current) {
          resumed.current = true;
          params.delete(OPENING_REQUEST_PARAM);
          const search = params.toString();
          window.history.replaceState(
            window.history.state,
            "",
            `${window.location.pathname}${search ? `?${search}` : ""}${window.location.hash}`,
          );
          if (!response.notification.requested) void changeOpeningRequest(true);
        }
      })
      .catch(() => {
        if (active) setOpeningRequested(null);
      });
    return () => {
      active = false;
    };
    // changeOpeningRequest ne dépend que de l'état du moment du retour : l'effet suit le compte.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  if (openingRequested) {
    return (
      <div className={className}>
        <p role="status" className="font-medium">
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
        <OfferOpeningSurvey key={survey?.answeredAt ?? "new"} initial={survey} />
      </div>
    );
  }

  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => changeOpeningRequest(true)}
        disabled={openingBusy || loading}
        className={`${
          primary
            ? "ij-signup-button px-5 py-3 font-bold"
            : "ij-login-button px-4 py-2 font-semibold"
        } inline-flex w-full items-center justify-center gap-2 text-sm disabled:cursor-not-allowed disabled:opacity-60`}
      >
        <Bell className="h-4 w-4" aria-hidden />
        Me prévenir de l’ouverture
      </button>
      <p className="mt-2 text-xs text-muted-foreground">
        {user ? OFFER_OPENING_CONSENT_TEXT : ANONYMOUS_HELP}
      </p>
    </div>
  );
}
