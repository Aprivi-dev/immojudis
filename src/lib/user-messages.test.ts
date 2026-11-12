import { describe, expect, it } from "vitest";
import { GENERIC_ERROR_MESSAGE, userMessage } from "./user-messages";
import { ConfigurationError } from "@/lib/api-errors";

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

  it("choisit la phrase selon le statut HTTP", () => {
    const http = (status: number) => Object.assign(new Error(`Erreur HTTP ${status}`), { status });
    expect(userMessage(http(401))).toBe("Votre session a expiré. Reconnectez-vous.");
    expect(userMessage(http(429))).toContain("Trop de demandes");
    expect(userMessage(http(403))).toBe("Vous n'avez pas accès à cette action.");
    expect(userMessage(http(503))).toContain("momentanément indisponible");
  });

  it("traduit « Connexion requise » et garde le texte de repli pour les erreurs inconnues", () => {
    expect(userMessage(new Error("Connexion requise."))).toBe("Connectez-vous pour continuer.");
    expect(
      userMessage(
        new ConfigurationError(
          "Stripe Analyse n'est pas configuré: STRIPE_ANALYSIS_PRICE_ID manquant",
        ),
        "Paiement indisponible",
      ),
    ).toBe("Paiement indisponible");
  });

  it("montre tel quel le message choisi par le serveur quand l'enveloppe de l'API porte un code", () => {
    const api = (status: number, code: string, message: string) =>
      Object.assign(new Error(message), { status, code });
    // Le serveur a déjà jugé ce message public : le navigateur ne le remplace plus.
    expect(
      userMessage(api(429, "RATE_LIMITED", "Limite quotidienne atteinte, réessayez demain.")),
    ).toBe("Limite quotidienne atteinte, réessayez demain.");
    expect(userMessage(api(503, "INTERNAL_ERROR", "Catalogue indisponible."))).toBe(
      "Catalogue indisponible.",
    );
    expect(userMessage(api(400, "INVALID_REQUEST", ""), "Oups")).toBe("Oups");
    // Un code qui n'est pas celui de l'enveloppe (Supabase, PostgreSQL) garde les règles du navigateur.
    expect(userMessage({ code: "PGRST116", message: "JSON object requested" })).toBe(
      GENERIC_ERROR_MESSAGE,
    );
    expect(userMessage({ code: "toString", message: "relation x" })).toBe(GENERIC_ERROR_MESSAGE);
  });
});
