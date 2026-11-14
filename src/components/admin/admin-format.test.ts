import { afterEach, describe, expect, it, vi } from "vitest";
import { apiRequest } from "@/lib/client-api-core";
import { formatCompactDateTime, queryErrorMessage } from "./admin-format";

// 23:30 UTC le 31 octobre est déjà le 1er novembre à Paris (UTC+1) : le jour et l'heure affichés
// sont ceux de Paris, quel que soit le fuseau du navigateur de l'administrateur.
const LATE_EVENING_UTC = "2026-10-31T23:30:00.000Z";

describe("formats des écrans admin", () => {
  it("affiche date et heure de Paris", () => {
    expect(formatCompactDateTime(LATE_EVENING_UTC)).toBe("01/11 00:30");
  });

  it("rend une valeur illisible telle quelle au lieu de faire échouer l'écran", () => {
    expect(formatCompactDateTime("pas une date")).toBe("pas une date");
  });

  it("garde le message d'une erreur, sinon le texte de repli", () => {
    expect(queryErrorMessage(new Error("Session expirée"), "Chargement impossible")).toBe(
      "Session expirée",
    );
    expect(queryErrorMessage(new Error(""), "Chargement impossible")).toBe("Chargement impossible");
    expect(queryErrorMessage("échec", "Chargement impossible")).toBe("Chargement impossible");
  });
});

// Audit du 14/11/2026 (I2) : les écrans admin affichent le message de l'erreur ; un délai dépassé
// ou une coupure réseau arrivent déjà traduits par `apiFetch`.
describe("message d'une requête admin qui n'aboutit pas", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("affiche en français une coupure réseau", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const error = await apiRequest("/api/admin/dashboard", { anonymous: true }).catch(
      (caught: unknown) => caught,
    );
    expect(queryErrorMessage(error, "Chargement impossible")).toBe(
      "Connexion impossible. Vérifiez votre réseau puis réessayez.",
    );
  });

  it("affiche en français un délai dépassé", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_path: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) =>
            init.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
          ),
      ),
    );
    const error = await apiRequest("/api/admin/dashboard", {
      anonymous: true,
      timeoutMs: 5,
    }).catch((caught: unknown) => caught);
    expect(queryErrorMessage(error, "Chargement impossible")).toBe(
      "Le serveur met trop de temps à répondre. Réessayez dans un instant.",
    );
  });
});
