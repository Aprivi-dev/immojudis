import { useEffect, useState } from "react";
import { trackProductEvent } from "@/lib/product-events";

export type CheckoutReturn = "success" | "cancelled" | null;

/** Reads `?checkout=success|cancelled` as set by the Stripe success and cancel URLs. */
export function parseCheckoutReturn(search: string): CheckoutReturn {
  const value = new URLSearchParams(search).get("checkout");
  return value === "success" || value === "cancelled" ? value : null;
}

/** The same address without the Stripe return parameters. */
export function withoutCheckoutReturn(location: Pick<Location, "pathname" | "search" | "hash">) {
  const params = new URLSearchParams(location.search);
  params.delete("checkout");
  params.delete("session_id");
  const query = params.toString();
  return `${location.pathname}${query ? `?${query}` : ""}${location.hash}`;
}

/**
 * Remembers how the visitor came back from Stripe, then removes the parameters
 * from the address so a reload or a shared link does not replay the message.
 */
export function useCheckoutReturn(enabled = true): CheckoutReturn {
  const [result, setResult] = useState<CheckoutReturn>(null);

  useEffect(() => {
    if (!enabled) return;
    const found = parseCheckoutReturn(window.location.search);
    if (!found) return;
    setResult(found);
    trackProductEvent("checkout_returned", { status: found });
    window.history.replaceState(window.history.state, "", withoutCheckoutReturn(window.location));
  }, [enabled]);

  return result;
}
