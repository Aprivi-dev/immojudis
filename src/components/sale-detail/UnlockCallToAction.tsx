"use client";

import { createContext, useContext, type MouseEvent, type ReactNode } from "react";
import Link from "next/link";
import { OfferOpeningRequest } from "@/components/OfferOpeningRequest";
import { useAnalysisCheckoutOpen } from "@/hooks/use-analysis-checkout-open";
import {
  type SaleUnlockStatus,
  unlockCallToActionLabel,
  unlockQuotaResetLine,
} from "@/lib/sale-unlocks";

/** `id` of the unlock card (SaleUnlockPanel): the target of « Débloquer cette vente ». */
export const UNLOCK_PANEL_ID = "debloquer";

/**
 * The state of the unlock on this sale page, for the paid previews that say « avec l'offre Analyse
 * ou en débloquant cette vente ». It is only provided when the unlock card is really on the page
 * (signed-in Découverte account, sale that can be unlocked): without it, a preview keeps its
 * single link to the offer.
 */
const SaleUnlockOfferContext = createContext<SaleUnlockStatus | null>(null);

export function SaleUnlockOfferProvider({
  status,
  children,
}: {
  status: SaleUnlockStatus | null;
  children: ReactNode;
}) {
  return (
    <SaleUnlockOfferContext.Provider value={status}>{children}</SaleUnlockOfferContext.Provider>
  );
}

/**
 * Moves to the unlock card and puts the focus on its button. The card is above the tabs, so the
 * link works from any tab and wherever the page was scrolled to; the hash is left alone on purpose
 * (an unknown hash makes the page fall back to the first tab).
 */
function goToUnlockPanel(event: MouseEvent<HTMLAnchorElement>) {
  const panel = document.getElementById(UNLOCK_PANEL_ID);
  if (!panel) return;
  event.preventDefault();
  panel.scrollIntoView({ block: "start" });
  panel.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
}

type Classes = {
  /** The main link (gold button, or the underlined link of a compact preview). */
  primaryClassName?: string;
  /** The secondary link to the offer, next to the unlock link. */
  secondaryClassName?: string;
  /** The sentence « Vos 3 déblocages … reviennent le … ». */
  messageClassName?: string;
};

/**
 * What a paid preview offers next to its message:
 *  - unlocks left: « Débloquer cette vente (il vous reste N sur 3) » first, then the offer;
 *  - quota spent: when the unlocks come back, then the offer (or « Me prévenir de l'ouverture »
 *    when it is not open for subscription and `withOpeningRequest` is set);
 *  - no unlock card on the page: the offer alone, as before.
 * Renders a fragment: place it in the preview's own row of links.
 */
export function UnlockCallToAction({
  offerLabel = "Découvrir l’offre Analyse",
  withOpeningRequest = false,
  onlyWithUnlockCard = false,
  primaryClassName,
  secondaryClassName,
  messageClassName,
}: Classes & {
  /** Label of the link to the offer when it is the only action. */
  offerLabel?: string;
  /** Show the full « Me prévenir de l'ouverture » request instead of a link when the offer is closed. */
  withOpeningRequest?: boolean;
  /** Render nothing when the page has no unlock card (a hint that adds to a text with no link). */
  onlyWithUnlockCard?: boolean;
}) {
  const status = useContext(SaleUnlockOfferContext);
  if (!status || status.analysisAccess) {
    if (onlyWithUnlockCard) return null;
    return (
      <Link href="/offres" className={primaryClassName}>
        {offerLabel}
      </Link>
    );
  }
  if ((status.remaining ?? 0) > 0) {
    return (
      <>
        <a href={`#${UNLOCK_PANEL_ID}`} onClick={goToUnlockPanel} className={primaryClassName}>
          {unlockCallToActionLabel(status)}
        </a>{" "}
        <Link href="/offres" className={secondaryClassName ?? primaryClassName}>
          {offerLabel}
        </Link>
      </>
    );
  }
  return (
    <SpentUnlocks
      status={status}
      withOpeningRequest={withOpeningRequest}
      primaryClassName={primaryClassName}
      messageClassName={messageClassName}
    />
  );
}

/** Quota spent: the return date, then the way to the offer. Only here is the offer state read. */
function SpentUnlocks({
  status,
  withOpeningRequest,
  primaryClassName,
  messageClassName,
}: Pick<Classes, "primaryClassName" | "messageClassName"> & {
  status: SaleUnlockStatus;
  withOpeningRequest: boolean;
}) {
  const checkoutOpen = useAnalysisCheckoutOpen();
  return (
    <>
      <p className={messageClassName}>{unlockQuotaResetLine(status)}</p>
      {checkoutOpen === false && withOpeningRequest ? (
        <div className="w-full max-w-sm">
          <OfferOpeningRequest className="mt-0" />
        </div>
      ) : (
        <Link href="/offres" className={primaryClassName}>
          Voir l’offre Analyse
        </Link>
      )}
    </>
  );
}
