import { describe, expect, it } from "vitest";
import { parseCheckoutReturn, withoutCheckoutReturn } from "@/hooks/use-checkout-return";

describe("retour de Stripe", () => {
  it("lit checkout=success et checkout=cancelled, rien d'autre", () => {
    expect(parseCheckoutReturn("?checkout=success&session_id=cs_test_1")).toBe("success");
    expect(parseCheckoutReturn("?checkout=cancelled")).toBe("cancelled");
    expect(parseCheckoutReturn("?checkout=autre")).toBeNull();
    expect(parseCheckoutReturn("")).toBeNull();
  });

  it("retire checkout et session_id de l'adresse et garde le reste", () => {
    expect(
      withoutCheckoutReturn({
        pathname: "/offres",
        search: "?checkout=success&session_id=cs_test_1&utm=a",
        hash: "#tarifs",
      }),
    ).toBe("/offres?utm=a#tarifs");
    expect(
      withoutCheckoutReturn({ pathname: "/offres", search: "?checkout=cancelled", hash: "" }),
    ).toBe("/offres");
  });
});
