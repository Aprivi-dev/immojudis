"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { Badge, Button, buttonClasses } from "@/components/ui/primitives";
import { OfferOpeningRequest } from "@/components/OfferOpeningRequestLazy";
import type { SaleUnlockPurchaseOfferState } from "@/hooks/use-sale-unlock-purchase-offer";
import { rememberCreditsBeforePurchase } from "@/components/sale-detail/use-sale-unlock-purchase-return";
import { saleUnlockCheckoutRefusalCode, startSaleUnlockCheckout } from "@/lib/client-billing";
import { LEGAL_DOCUMENTS } from "@/lib/legal-documents";
import {
  SALE_PURCHASE_CONSENT_MISSING_TEXT,
  SALE_PURCHASE_CREDIT_REMINDER,
  SALE_PURCHASE_IMMEDIATE_ACCESS_TEXT,
  SALE_UNLOCK_CHECKOUT_CONFLICT_TEXTS,
  saleUnlockPurchaseChoiceTexts,
} from "@/lib/sale-unlocks";
import { userMessage } from "@/lib/user-messages";

type ReadyOffer = Extract<SaleUnlockPurchaseOfferState, { status: "ready" }> & {
  purchase: NonNullable<Extract<SaleUnlockPurchaseOfferState, { status: "ready" }>["purchase"]>;
};

/**
 * Les deux façons d'ouvrir la vente quand le déblocage du compte gratuit a servi et que l'achat à
 * l'unité est ouvert : l'abonnement d'abord, mis en avant comme l'offre recommandée de /offres, puis
 * cette vente à l'unité. Côte à côte sur ordinateur, l'un sous l'autre sur mobile. Avant le paiement
 * de la vente, deux cases non cochées, obligatoires (conditions générales ; accès immédiat et perte
 * du droit de rétractation), sur le modèle du récapitulatif de l'abonnement (`BillingActions`). Pas
 * de compte à rebours, pas de rareté : les montants viennent de l'offre lue.
 */
export function SaleUnlockPurchaseChoices({
  saleId,
  credits,
  offer,
  onConflict,
  onAnnounce,
}: {
  saleId: string;
  /** Crédits du compte avant le paiement : au retour, un crédit de plus dit que l'achat en est devenu un. */
  credits: number;
  offer: ReadyOffer;
  /** Le serveur a refusé l'achat (409) : le message à montrer ; la fiche relit la situation. */
  onConflict: (text: string) => void;
  /** Texte à annoncer aux lecteurs d'écran (région `aria-live` de la carte). */
  onAnnounce: (text: string) => void;
}) {
  const { analysisOpen, analysisLabel, analysisCents, purchase, firstMonthDeductionCents } = offer;
  const texts = saleUnlockPurchaseChoiceTexts({
    unit: purchase,
    subscriptionLabel: analysisLabel,
    subscriptionCents: analysisCents,
    firstMonthDeductionCents,
  });
  const [step, setStep] = useState<"idle" | "consent" | "pending">("idle");
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [accessAccepted, setAccessAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstBoxRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const ids = useId();
  const subscriptionTitleId = `${ids}-abonnement`;
  const saleTitleId = `${ids}-vente`;
  const consentTitleId = `${ids}-consentement`;
  const missingId = `${ids}-manque`;
  const consentGiven = termsAccepted && accessAccepted;

  // The button that opened the consent disappears: the focus moves to the first box, and back.
  useEffect(() => {
    if (step === "consent") firstBoxRef.current?.focus();
    if (step === "idle" && returnFocus.current) {
      returnFocus.current = false;
      triggerRef.current?.focus();
    }
  }, [step]);

  function openConsent() {
    setTermsAccepted(false);
    setAccessAccepted(false);
    setError(null);
    setStep("consent");
  }

  function cancel() {
    returnFocus.current = true;
    setStep("idle");
  }

  async function pay() {
    if (!consentGiven || step === "pending") return;
    setStep("pending");
    setError(null);
    onAnnounce("Ouverture du paiement…");
    try {
      const { url } = await startSaleUnlockCheckout({
        saleId,
        consent: {
          termsAccepted: true,
          termsVersion: LEGAL_DOCUMENTS.terms.version,
          privacyVersion: LEGAL_DOCUMENTS.privacy.version,
          // Première case : conditions générales et obligation de payer.
          paymentObligationAcknowledged: true,
          // Seconde case : accès immédiat et perte du droit de rétractation une fois l'accès fourni.
          immediatePerformanceRequested: true,
          withdrawalInformationAcknowledged: true,
          withdrawalWaiverAcknowledged: true,
        },
      });
      rememberCreditsBeforePurchase(saleId, credits);
      window.location.assign(url);
    } catch (failure) {
      const code = saleUnlockCheckoutRefusalCode(failure);
      if (code) {
        setStep("idle");
        onConflict(SALE_UNLOCK_CHECKOUT_CONFLICT_TEXTS[code]);
        return;
      }
      setStep("consent");
      const message = userMessage(failure, "Le paiement n’a pas pu être ouvert. Réessayez.");
      setError(message);
      onAnnounce("");
    }
  }

  const saleChoice = (
    <section
      aria-labelledby={saleTitleId}
      className="flex flex-col rounded-lg border border-line bg-white p-4"
    >
      <h3 id={saleTitleId} className="font-display text-xl text-brand-navy">
        {texts.saleTitle}
      </h3>
      <p className="mt-2 text-sm leading-relaxed text-ink-soft">{texts.saleText}</p>
      {analysisOpen && texts.saleDeduction ? (
        <p className="mt-2 text-sm leading-relaxed text-ink-soft">{texts.saleDeduction}</p>
      ) : null}
      {step === "idle" ? (
        <div className="mt-auto pt-4">
          <Button ref={triggerRef} className="w-full" onClick={openConsent}>
            {texts.saleCallToAction}
          </Button>
        </div>
      ) : (
        <div
          role="group"
          aria-labelledby={consentTitleId}
          className="mt-4 rounded-lg border border-gold/40 bg-surface-tint p-4"
        >
          <h4 id={consentTitleId} className="text-sm font-semibold text-brand-navy">
            Avant le paiement
          </h4>
          <p className="mt-1 text-sm leading-relaxed text-brand-navy">
            Déblocage de cette vente : {purchase.label}, paiement unique par carte sur la page
            sécurisée de Stripe, qui affiche le montant avant confirmation.
          </p>
          <label className="mt-3 flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-line bg-white p-3 text-sm leading-relaxed">
            <input
              ref={firstBoxRef}
              type="checkbox"
              checked={termsAccepted}
              onChange={(event) => setTermsAccepted(event.target.checked)}
              disabled={step === "pending"}
              className="mt-1 size-4 shrink-0"
            />
            <span>
              J’accepte les{" "}
              <Link
                href="/conditions-generales"
                target="_blank"
                className="font-semibold text-gold-text underline"
              >
                conditions générales
              </Link>{" "}
              (version {LEGAL_DOCUMENTS.terms.version}) et je reconnais que la commande m’oblige à
              payer {purchase.label}.
            </span>
          </label>
          <label className="mt-2 flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-line bg-white p-3 text-sm leading-relaxed">
            <input
              type="checkbox"
              checked={accessAccepted}
              onChange={(event) => setAccessAccepted(event.target.checked)}
              disabled={step === "pending"}
              className="mt-1 size-4 shrink-0"
            />
            <span>{SALE_PURCHASE_IMMEDIATE_ACCESS_TEXT}</span>
          </label>
          <p className="mt-3 text-sm font-medium leading-relaxed text-brand-navy">
            {SALE_PURCHASE_CREDIT_REMINDER}
          </p>
          <p className="mt-2 text-xs leading-relaxed text-ink-soft">
            L’achat est enregistré sur votre compte (vente, date, versions acceptées).{" "}
            <Link
              href="/privacy"
              target="_blank"
              className="font-semibold underline underline-offset-4"
            >
              Politique de confidentialité
            </Link>
          </p>
          <div className="mt-3 flex flex-wrap gap-3">
            <Button
              variant="primary"
              onClick={() => void pay()}
              disabled={!consentGiven || step === "pending"}
              aria-describedby={consentGiven ? undefined : missingId}
            >
              {step === "pending"
                ? "Ouverture du paiement…"
                : "Commander avec obligation de paiement"}
            </Button>
            <Button variant="secondary" onClick={cancel} disabled={step === "pending"}>
              Annuler
            </Button>
          </div>
          {consentGiven ? null : (
            <p id={missingId} className="mt-2 text-xs leading-relaxed text-ink-soft">
              {SALE_PURCHASE_CONSENT_MISSING_TEXT}
            </p>
          )}
          {error ? (
            <p role="alert" className="mt-3 text-sm text-danger">
              {error}
            </p>
          ) : null}
        </div>
      )}
    </section>
  );

  if (!analysisOpen) {
    // L'abonnement ne se souscrit pas : il n'est pas proposé, la demande d'ouverture reste.
    return (
      <>
        <div className="mt-4">{saleChoice}</div>
        <p className="mt-4 text-sm leading-relaxed text-ink-soft">
          L’offre Analyse n’est pas encore ouverte à la souscription.
        </p>
        <div className="mt-3 max-w-sm">
          <OfferOpeningRequest className="mt-0" />
        </div>
      </>
    );
  }

  return (
    <div className="mt-4 grid gap-4 sm:grid-cols-2">
      <section
        aria-labelledby={subscriptionTitleId}
        className="flex flex-col rounded-lg border border-brand-navy bg-white p-4"
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h3 id={subscriptionTitleId} className="font-display text-xl text-brand-navy">
            {texts.subscriptionTitle}
          </h3>
          <Badge tone="gold">Recommandée</Badge>
        </div>
        <p className="mt-2 text-sm leading-relaxed text-ink-soft">{texts.subscriptionText}</p>
        {texts.subscriptionDeduction ? (
          <p className="mt-2 text-sm font-medium leading-relaxed text-brand-navy">
            {texts.subscriptionDeduction}
          </p>
        ) : null}
        <div className="mt-auto pt-4">
          <Link
            href="/offres#tarifs"
            className={buttonClasses({ variant: "primary", className: "w-full" })}
          >
            Choisir l’abonnement Analyse
          </Link>
        </div>
      </section>
      {saleChoice}
    </div>
  );
}
