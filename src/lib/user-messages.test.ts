import { describe, expect, it } from "vitest";
import { GENERIC_ERROR_MESSAGE, userMessage } from "./user-messages";

describe("userMessage", () => {
  it("translates Supabase auth errors", () => {
    expect(userMessage(new Error("Invalid login credentials"))).toBe(
      "Email ou mot de passe incorrect.",
    );
    expect(userMessage({ message: "Email not confirmed" })).toBe(
      "Confirmez votre adresse email avant de vous connecter.",
    );
  });

  it("explains statement timeouts without leaking SQL details", () => {
    const error = {
      code: "57014",
      message: "canceling statement due to statement timeout",
    };
    expect(userMessage(error)).toBe(
      "Le service met trop de temps à répondre. Réessayez dans quelques secondes.",
    );
  });

  it("recognises network failures and rate limits", () => {
    expect(userMessage(new TypeError("Failed to fetch"))).toContain("Connexion impossible");
    expect(userMessage({ status: 429, message: "x" })).toContain("Trop de demandes");
  });

  it("lets application messages written in French through", () => {
    const message = "Localisation introuvable. Précisez la ville ou l’adresse.";
    expect(userMessage(new Error(message))).toBe(message);
  });

  it("never exposes technical vocabulary", () => {
    expect(userMessage(new Error('relation "auction_sales" does not exist'))).toBe(
      GENERIC_ERROR_MESSAGE,
    );
    expect(userMessage(new Error("STRIPE_ANALYSIS_PRICE_ID manquant"))).toBe(GENERIC_ERROR_MESSAGE);
    expect(userMessage(new Error("PGRST116: JSON object requested"))).toBe(GENERIC_ERROR_MESSAGE);
  });

  it("falls back for unknown values", () => {
    expect(userMessage(undefined)).toBe(GENERIC_ERROR_MESSAGE);
    expect(userMessage(null, "Oups")).toBe("Oups");
    expect(userMessage({})).toBe(GENERIC_ERROR_MESSAGE);
  });
});
