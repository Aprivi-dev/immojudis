"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import LockKeyhole from "lucide-react/dist/esm/icons/lock-keyhole.js";
import LockKeyholeOpen from "lucide-react/dist/esm/icons/lock-keyhole-open.js";
import { Button, Card, Eyebrow, buttonClasses } from "@/components/ui/primitives";
import { useAnalysisCheckoutOpen } from "@/hooks/use-analysis-checkout-open";
import { SaleUnlockQuotaReachedError, unlockSaleRequest } from "@/lib/client-api";
import { resolveAnalysisOfferLabel } from "@/lib/analysis-offer";
import {
  MONTHLY_SALE_UNLOCKS,
  remainingUnlocksLine,
  unlockConfirmationText,
  unlockedItemsText,
  unlockQuotaReachedText,
  type SaleUnlockResult,
  type SaleUnlockStatus,
} from "@/lib/sale-unlocks";
import { userMessage } from "@/lib/user-messages";

/**
 * « Débloquer cette vente » : « 3 déblocages par mois » du compte Découverte.
 *
 * Un déblocage ouvre, pour cette vente seulement, de quoi préparer l'enchère. Il est consommé après
 * confirmation, une seule fois par vente, et ne s'affiche jamais à un abonné Analyse. Pas de
 * compte à rebours ni de rareté artificielle : le nombre restant et la date de remise à zéro.
 */
export function SaleUnlockPanel({
  saleId,
  status,
  unlocked,
  opens = { ceiling: true, statistics: true },
  announce = false,
  onUnlocked,
}: {
  saleId: string;
  /** Situation du compte ce mois-ci ; absente tant qu'elle n'est pas connue (rien n'est affiché). */
  status: SaleUnlockStatus | null | undefined;
  /** La vente est déjà débloquée : le panneau rappelle ce qui est ouvert. */
  unlocked: boolean;
  /** What this sale really offers once unlocked (no ceiling on a notarial sale, for instance). */
  opens?: { ceiling: boolean; statistics: boolean };
  /** The sale was unlocked a moment ago: move the focus to the result so it is announced. */
  announce?: boolean;
  onUnlocked: (result: SaleUnlockResult) => void;
}) {
  const items = unlockedItemsText(opens);
  const [step, setStep] = useState<"idle" | "confirm" | "pending">("idle");
  const [error, setError] = useState<string | null>(null);
  // A refusal (quota spent elsewhere in the meantime) only holds for the status it was given for.
  const [refused, setRefused] = useState<{
    base: SaleUnlockStatus;
    status: SaleUnlockStatus;
  } | null>(null);
  const [live, setLive] = useState("");
  const confirmRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // The button that opened the confirmation disappears: the focus moves to the confirmation.
  useEffect(() => {
    if (step === "confirm") confirmRef.current?.focus();
  }, [step]);
  useEffect(() => {
    if (announce && unlocked) headingRef.current?.focus();
  }, [announce, unlocked]);

  if (!status || status.analysisAccess) return null;
  const base = status;
  const current = refused && refused.base === base ? refused.status : base;
  // Kept mounted across the three states, so what happens (pending, spent quota) is announced.
  const liveRegion = (
    <p role="status" aria-live="polite" className="sr-only">
      {live}
    </p>
  );

  if (unlocked) {
    return (
      <>
        {liveRegion}
        <Card as="section" aria-labelledby="sale-unlock-title" className="mt-4 border-gold/40">
          <Eyebrow className="flex items-center gap-2">
            <LockKeyholeOpen className="size-4" aria-hidden /> Vente débloquée
          </Eyebrow>
          <h2
            id="sale-unlock-title"
            ref={headingRef}
            tabIndex={-1}
            className="mt-2 font-display text-2xl text-brand-navy focus:outline-none"
          >
            Cette vente est débloquée
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-ink-soft">
            Pour cette vente seulement : {items}. Elle reste accessible tant qu’elle est en ligne
            sur Immojudis, dans la limite de 24 mois. Les exports PDF et CSV, les rapports
            enregistrés, l’estimation détaillée et les ventes comparables restent réservés à l’offre
            Analyse.
          </p>
          <p className="mt-2 text-xs leading-relaxed text-ink-soft">
            Ces éléments sont une aide à la décision : ils ne constituent ni un conseil juridique ni
            un conseil financier, et l’enchère plafond est une simulation fondée sur des hypothèses
            modifiables.
          </p>
          {remainingUnlocksLine(current) ? (
            <p className="mt-2 text-sm font-medium text-brand-navy">
              {remainingUnlocksLine(current)}
            </p>
          ) : null}
        </Card>
      </>
    );
  }

  const exhausted = (current.remaining ?? 0) <= 0;

  async function confirmUnlock() {
    setStep("pending");
    setError(null);
    setLive("Déblocage en cours…");
    try {
      const result = await unlockSaleRequest(saleId);
      setStep("idle");
      setLive("Vente débloquée.");
      onUnlocked(result);
    } catch (failure) {
      setStep("idle");
      if (failure instanceof SaleUnlockQuotaReachedError) {
        setRefused({ base, status: failure.status });
        setLive(unlockQuotaReachedText(failure.status));
        return;
      }
      setLive("");
      setError(userMessage(failure, "Le déblocage n’a pas pu être effectué. Réessayez."));
    }
  }

  if (exhausted) {
    return (
      <>
        {liveRegion}
        <Card as="section" aria-labelledby="sale-unlock-title" className="mt-4">
          <Eyebrow className="flex items-center gap-2">
            <LockKeyhole className="size-4" aria-hidden /> {MONTHLY_SALE_UNLOCKS} déblocages par
            mois
          </Eyebrow>
          <h2 id="sale-unlock-title" className="mt-2 font-display text-2xl text-brand-navy">
            Vous avez utilisé vos déblocages
          </h2>
          <ExhaustedNotice status={current} />
          <Link href="/offres" className={buttonClasses({ variant: "primary", className: "mt-4" })}>
            Découvrir l’offre Analyse
          </Link>
        </Card>
      </>
    );
  }

  return (
    <>
      {liveRegion}
      <Card as="section" aria-labelledby="sale-unlock-title" className="mt-4">
        <Eyebrow className="flex items-center gap-2">
          <LockKeyhole className="size-4" aria-hidden /> {MONTHLY_SALE_UNLOCKS} déblocages par mois
        </Eyebrow>
        <h2 id="sale-unlock-title" className="mt-2 font-display text-2xl text-brand-navy">
          Débloquer cette vente
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-soft">
          Ouvre, pour cette vente seulement : {items}. Elle reste accessible tant qu’elle est en
          ligne, dans la limite de 24 mois. Compris dans le compte Découverte, sans carte bancaire.
        </p>
        <p className="mt-2 text-sm font-medium text-brand-navy">{remainingUnlocksLine(current)}</p>
        {step === "idle" ? (
          <Button
            variant="primary"
            className="mt-4"
            onClick={() => {
              setError(null);
              setStep("confirm");
            }}
          >
            Débloquer cette vente
          </Button>
        ) : (
          <div
            role="group"
            aria-label="Confirmer le déblocage"
            className="mt-4 rounded-lg border border-gold/40 bg-surface-tint p-4"
          >
            <p className="text-sm leading-relaxed text-brand-navy">
              {unlockConfirmationText(current)}
            </p>
            <p className="mt-2 text-xs leading-relaxed text-ink-soft">
              Le déblocage est enregistré sur votre compte (vente et date).{" "}
              <Link href="/privacy" className="font-semibold underline underline-offset-4">
                Politique de confidentialité
              </Link>
            </p>
            <div className="mt-3 flex flex-wrap gap-3">
              <Button
                ref={confirmRef}
                variant="primary"
                onClick={() => void confirmUnlock()}
                disabled={step === "pending"}
              >
                {step === "pending" ? "Déblocage en cours…" : "Confirmer le déblocage"}
              </Button>
              <Button
                variant="secondary"
                onClick={() => setStep("idle")}
                disabled={step === "pending"}
              >
                Annuler
              </Button>
            </div>
          </div>
        )}
        {error ? (
          <p role="alert" className="mt-3 text-sm text-red-700">
            {error}
          </p>
        ) : null}
      </Card>
    </>
  );
}

/**
 * Spent quota: the reset date, and a subscription is suggested only when it can really be bought
 * (the legal identity is published and the approved price is configured), never before.
 */
function ExhaustedNotice({ status }: { status: SaleUnlockStatus }) {
  const checkoutOpen = useAnalysisCheckoutOpen();
  return (
    <p className="mt-2 text-sm leading-relaxed text-ink-soft">
      {unlockQuotaReachedText(status)}{" "}
      {checkoutOpen === true
        ? `Analyse ouvre toutes les ventes sans limite : ${resolveAnalysisOfferLabel()}, résiliable à tout moment.`
        : checkoutOpen === false
          ? "L’offre Analyse n’est pas encore ouverte à la souscription."
          : null}
    </p>
  );
}
