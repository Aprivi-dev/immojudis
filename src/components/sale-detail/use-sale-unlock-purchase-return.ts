import { useEffect, useRef, useState } from "react";
import { SALE_UNLOCK_CHECKOUT_RETURN_PARAM } from "@/lib/analysis-offer";

/*
 * Retour du paiement Stripe d'une vente à l'unité : `?unlock_checkout=success` (paiement abouti) ou
 * `cancelled` (abandon), posé par les adresses de retour de la session (`SALE_UNLOCK_CHECKOUT_RETURN_PARAM`).
 */
export type SalePurchaseReturn = "success" | "cancelled" | null;

export function parseSalePurchaseReturn(search: string): SalePurchaseReturn {
  const value = new URLSearchParams(search).get(SALE_UNLOCK_CHECKOUT_RETURN_PARAM);
  return value === "success" || value === "cancelled" ? value : null;
}

/** La même adresse sans les paramètres du retour de Stripe. */
export function withoutSalePurchaseReturn(
  location: Pick<Location, "pathname" | "search" | "hash">,
): string {
  const params = new URLSearchParams(location.search);
  params.delete(SALE_UNLOCK_CHECKOUT_RETURN_PARAM);
  params.delete("session_id");
  const query = params.toString();
  return `${location.pathname}${query ? `?${query}` : ""}${location.hash}`;
}

/**
 * Délais des relectures de l'état du déblocage après un paiement : le webhook de Stripe peut mettre
 * quelques secondes à arriver. Environ 30 s en tout, puis la fiche dit quoi faire.
 */
export const SALE_PURCHASE_POLL_DELAYS_MS = [2_000, 3_000, 5_000, 8_000, 12_000] as const;

/**
 * `pending` : paiement reçu, déblocage pas encore confirmé ; `delayed` : toujours pas après les
 * relectures ; `credited` : la vente n'était plus disponible, l'achat est devenu un crédit.
 */
export type SalePurchaseReturnPhase = "pending" | "delayed" | "credited" | null;

/*
 * Le nombre de crédits du compte juste avant de partir vers Stripe, gardé dans l'onglet : au retour,
 * la page est rechargée et seul ce repère dit si l'achat est devenu un crédit. Illisible (stockage
 * refusé, autre onglet) : la fiche retombe sur l'attente puis le message de secours.
 */
const CREDITS_BEFORE_KEY = (saleId: string) => `immojudis:achat-vente:credits-avant:${saleId}`;

export function rememberCreditsBeforePurchase(saleId: string, credits: number): void {
  try {
    window.sessionStorage.setItem(CREDITS_BEFORE_KEY(saleId), String(credits));
  } catch {
    // Stockage refusé : le retour n'aura pas de repère, voir ci-dessus.
  }
}

function readCreditsBeforePurchase(saleId: string): number | null {
  try {
    const value = window.sessionStorage.getItem(CREDITS_BEFORE_KEY(saleId));
    const credits = value == null ? Number.NaN : Number(value);
    return Number.isInteger(credits) && credits >= 0 ? credits : null;
  } catch {
    return null;
  }
}

function forgetCreditsBeforePurchase(saleId: string): void {
  try {
    window.sessionStorage.removeItem(CREDITS_BEFORE_KEY(saleId));
  } catch {
    // Rien à oublier.
  }
}

type StatusRead = { unlocked: boolean; credits?: number };

/**
 * Lit le retour de Stripe une fois la page montée (la fiche est en cache statique : l'adresse ne se
 * lit pas au rendu), retire les paramètres de l'adresse, puis relit l'état du déblocage à intervalles
 * croissants jusqu'à ce que le serveur le confirme. Jamais « débloqué » par anticipation : seul
 * `unlocked` (la réponse du serveur) termine l'attente, et `onConfirmed` est alors appelé une fois.
 * Si le compte a gagné un crédit depuis le départ vers Stripe sans que la vente soit ouverte, l'achat
 * est devenu un crédit : `credited`, sans attendre la fin des relectures. Une annulation ne laisse
 * aucune trace : la fiche reste dans l'état d'achat.
 */
export function useSalePurchaseReturn({
  saleId,
  enabled,
  unlocked,
  credits,
  refetch,
  onConfirmed,
}: {
  saleId: string;
  /** L'état du déblocage se lit (compte Découverte connecté, droits connus). */
  enabled: boolean;
  unlocked: boolean;
  /** Crédits de déblocage disponibles, tels que le serveur les donne. */
  credits: number;
  /** Relit l'état du déblocage ; la réponse dit si la vente est débloquée. */
  refetch: () => Promise<{ data?: StatusRead | undefined }>;
  onConfirmed: () => void;
}): SalePurchaseReturnPhase {
  const [phase, setPhase] = useState<SalePurchaseReturnPhase>(null);
  const [creditsBefore, setCreditsBefore] = useState<number | null>(null);
  const refetchRef = useRef(refetch);
  const confirmedRef = useRef(onConfirmed);
  useEffect(() => {
    refetchRef.current = refetch;
    confirmedRef.current = onConfirmed;
  });

  useEffect(() => {
    const found = parseSalePurchaseReturn(window.location.search);
    if (!found) return;
    window.history.replaceState(
      window.history.state,
      "",
      withoutSalePurchaseReturn(window.location),
    );
    if (found === "success") {
      setCreditsBefore(readCreditsBeforePurchase(saleId));
      setPhase("pending");
    }
    forgetCreditsBeforePurchase(saleId);
  }, [saleId]);

  useEffect(() => {
    if (phase === null || phase === "credited" || !enabled) return;
    if (unlocked) {
      setPhase(null);
      confirmedRef.current();
      return;
    }
    const credited = (read: StatusRead | undefined) =>
      creditsBefore != null && read != null && (read.credits ?? 0) > creditsBefore;
    if (credited({ unlocked, credits })) {
      setPhase("credited");
      return;
    }
    if (phase !== "pending") return;
    let active = true;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const result = await refetchRef.current().catch(() => null);
      // Débloquée, ou devenue un crédit : l'effet repart avec le nouvel état et conclut.
      if (!active || result?.data?.unlocked || credited(result?.data)) return;
      attempt += 1;
      if (attempt >= SALE_PURCHASE_POLL_DELAYS_MS.length) {
        setPhase("delayed");
        return;
      }
      timer = setTimeout(poll, SALE_PURCHASE_POLL_DELAYS_MS[attempt]);
    };
    timer = setTimeout(poll, SALE_PURCHASE_POLL_DELAYS_MS[0]);
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [phase, enabled, unlocked, credits, creditsBefore]);

  return phase;
}
