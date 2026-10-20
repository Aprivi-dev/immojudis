"use client";

import { useState } from "react";
import { Button } from "@/components/ui/primitives";
import { useAuth } from "@/hooks/use-auth";
import { authHeaders } from "@/lib/client-api-core";
import {
  SALE_SIGNAL_QUESTIONS,
  SALE_SIGNAL_REASONS,
  SALE_SIGNAL_REASON_LABELS,
  SALE_SIGNAL_VALUES,
  SALE_SIGNAL_VALUE_LABELS,
  type SaleSignal,
  type SaleSignalReason,
  type SaleSignalValue,
} from "@/lib/sale-signal-feedback";

const PRESSED = "border-brand-navy bg-brand-navy text-white hover:bg-brand-navy-soft";

/** Envoie le retour ; vrai quand la base l'a enregistré. Sans session, `authHeaders` lève. */
async function sendFeedback(
  saleId: string,
  body: { signal: SaleSignal; value: SaleSignalValue; reason?: SaleSignalReason },
): Promise<boolean> {
  const response = await fetch(`/api/sales/${encodeURIComponent(saleId)}/signal-feedback`, {
    method: "POST",
    headers: { ...(await authHeaders()), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) return false;
  const payload = (await response.json().catch(() => null)) as { recorded?: unknown } | null;
  return payload?.recorded === true;
}

type Status = "idle" | "sending" | "sent" | "error";

/**
 * Retour en un clic sous un signal d'une vente (point 67) : « Utile » ou « Pas pertinent », puis, pour
 * « Pas pertinent », un motif facultatif en liste fermée (estimation trop haute ou trop basse pour la bande
 * d'écart au marché ; point faux ou point manquant pour la liste des points à vérifier). Aucun texte libre.
 *
 * Comptes connectés seulement : sans session le composant ne rend rien (pas de mesure anonyme, et la
 * route refuserait de toute façon). Rien n'est rendu non plus tant que la session est en cours de lecture,
 * ce qui garde le HTML du serveur identique à celui d'un visiteur.
 *
 * Le retour est rattaché au compte et à la vente, un seul par signal et par jour : choisir ensuite un
 * motif corrige le retour du jour au lieu d'en ajouter un.
 */
export function SaleSignalFeedback({
  saleId,
  signal,
  className = "",
}: {
  saleId: string;
  signal: SaleSignal;
  className?: string;
}) {
  const { user, loading } = useAuth();
  const [value, setValue] = useState<SaleSignalValue | null>(null);
  const [reason, setReason] = useState<SaleSignalReason | null>(null);
  const [status, setStatus] = useState<Status>("idle");

  if (loading || !user) return null;

  async function submit(nextValue: SaleSignalValue, nextReason: SaleSignalReason | null) {
    setStatus("sending");
    try {
      const recorded = await sendFeedback(saleId, {
        signal,
        value: nextValue,
        ...(nextReason ? { reason: nextReason } : {}),
      });
      if (!recorded) {
        setStatus("error");
        return;
      }
      setValue(nextValue);
      setReason(nextReason);
      setStatus("sent");
    } catch {
      setStatus("error");
    }
  }

  const sending = status === "sending";
  return (
    <div
      role="group"
      aria-label={SALE_SIGNAL_QUESTIONS[signal]}
      data-testid="sale-signal-feedback"
      data-signal={signal}
      className={`mt-3 text-sm text-ink-soft ${className}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span>{SALE_SIGNAL_QUESTIONS[signal]}</span>
        {SALE_SIGNAL_VALUES.map((option) => (
          <Button
            key={option}
            variant="secondary"
            aria-pressed={value === option}
            disabled={sending}
            className={value === option ? PRESSED : undefined}
            onClick={() => void submit(option, null)}
          >
            {SALE_SIGNAL_VALUE_LABELS[option]}
          </Button>
        ))}
      </div>
      {value === "not_relevant" ? (
        <div role="group" aria-label="Pourquoi ? (facultatif)" className="mt-2">
          <p className="mb-1 font-semibold text-brand-navy">Pourquoi ? (facultatif)</p>
          <div className="flex flex-wrap gap-2">
            {SALE_SIGNAL_REASONS[signal].map((option) => (
              <Button
                key={option}
                variant="secondary"
                aria-pressed={reason === option}
                disabled={sending}
                className={reason === option ? PRESSED : undefined}
                onClick={() => void submit("not_relevant", option)}
              >
                {SALE_SIGNAL_REASON_LABELS[option]}
              </Button>
            ))}
          </div>
        </div>
      ) : null}
      <p
        aria-live="polite"
        data-testid="sale-signal-feedback-status"
        className="mt-2 min-h-5 text-xs"
      >
        {status === "sent"
          ? "Merci, votre retour est enregistré."
          : status === "error"
            ? "Votre retour n’a pas pu être enregistré. Réessayez dans un instant."
            : ""}
      </p>
    </div>
  );
}
