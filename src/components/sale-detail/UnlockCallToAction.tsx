"use client";

import { createContext, useContext, type MouseEvent, type ReactNode } from "react";
import Link from "next/link";
import { OfferOpeningRequest } from "@/components/OfferOpeningRequestLazy";
import { useSaleUnlockPurchaseOffer } from "@/hooks/use-sale-unlock-purchase-offer";
import {
  type SaleUnlockStatus,
  UNLOCK_CALL_TO_ACTION_LABEL,
  UNLOCK_QUOTA_REACHED_TITLE,
} from "@/lib/sale-unlocks";
import {
  salePurchaseCallToActionLabel,
  UNLOCK_CREDIT_CALL_TO_ACTION_LABEL,
} from "@/lib/sale-unlock-purchase-texts";

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
  if (focusUnlockPanel()) event.preventDefault();
}

/** The same move for any link to `#debloquer` (hero, mobile bar); false without the card. */
export function focusUnlockPanel(): boolean {
  const panel = document.getElementById(UNLOCK_PANEL_ID);
  if (!panel) return false;
  panel.scrollIntoView?.({ block: "start" });
  panel.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
  return true;
}

type Classes = {
  /** The main link (gold button, or the underlined link of a compact preview). */
  primaryClassName?: string;
  /** The secondary link to the offer, next to the unlock link. */
  secondaryClassName?: string;
  /** The sentence « Votre compte gratuit a déjà débloqué une vente. » */
  messageClassName?: string;
};

/**
 * What a paid preview offers next to its message:
 *  - unlock left: « Débloquer cette vente avec mon compte gratuit » first, then the offer;
 *  - unlock spent, credit left (a purchased sale did not take place): « Débloquer cette vente avec
 *    mon crédit » first, then the offer;
 *  - unlock spent on another sale: says so, then, once the purchase of a single sale is open,
 *    « Acheter cette vente » to the unlock card, then the offer (or « Me prévenir de l'ouverture »
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
  const unlockLabel =
    (status.remaining ?? 0) > 0
      ? UNLOCK_CALL_TO_ACTION_LABEL
      : (status.credits ?? 0) > 0
        ? UNLOCK_CREDIT_CALL_TO_ACTION_LABEL
        : null;
  if (unlockLabel) {
    return (
      <>
        <a href={`#${UNLOCK_PANEL_ID}`} onClick={goToUnlockPanel} className={primaryClassName}>
          {unlockLabel}
        </a>{" "}
        <Link href="/offres" className={secondaryClassName ?? primaryClassName}>
          {offerLabel}
        </Link>
      </>
    );
  }
  return (
    <SpentUnlocks
      withOpeningRequest={withOpeningRequest}
      primaryClassName={primaryClassName}
      secondaryClassName={secondaryClassName}
      messageClassName={messageClassName}
    />
  );
}

/**
 * Unlock spent on another sale: says so, then (purchase open) the way to buy this sale on the unlock
 * card, where the consent is collected, then the way to the offer. Only here is the offer state
 * read.
 */
function SpentUnlocks({
  withOpeningRequest,
  primaryClassName,
  secondaryClassName,
  messageClassName,
}: Classes & {
  withOpeningRequest: boolean;
}) {
  const offer = useSaleUnlockPurchaseOffer();
  const checkoutOpen = offer.status === "loading" ? null : offer.analysisOpen;
  const purchase = offer.status === "ready" ? offer.purchase : null;
  return (
    <>
      <p className={messageClassName}>{UNLOCK_QUOTA_REACHED_TITLE}.</p>
      {purchase ? (
        <>
          <a href={`#${UNLOCK_PANEL_ID}`} onClick={goToUnlockPanel} className={primaryClassName}>
            {salePurchaseCallToActionLabel(purchase.label)}
          </a>{" "}
        </>
      ) : null}
      {checkoutOpen === false && withOpeningRequest ? (
        <div className="w-full max-w-sm">
          <OfferOpeningRequest className="mt-0" />
        </div>
      ) : (
        <Link
          href="/offres"
          className={purchase ? (secondaryClassName ?? primaryClassName) : primaryClassName}
        >
          Voir l’offre Analyse
        </Link>
      )}
    </>
  );
}
