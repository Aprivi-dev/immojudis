// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readStartCardClosed,
  startCardClosedKey,
  startComplete,
  startProgress,
  startSteps,
  writeStartCardClosed,
} from "@/lib/start-checklist";

const row = (
  sale_id: string,
  personal_status: string | null = null,
  bid_ceiling_eur: number | null = null,
) => ({ sale_id, personal_status, bid_ceiling_eur });

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("startProgress", () => {
  it("ne coche rien sans favori", () => {
    expect(startProgress([])).toEqual({
      followed: false,
      dossierFilled: false,
      dossierSaleId: null,
    });
  });

  it("coche « Suivre une vente » dès un favori, et propose le premier dossier encore vide", () => {
    expect(startProgress([row("a", "watching"), row("b"), row("c")])).toEqual({
      followed: true,
      dossierFilled: true,
      dossierSaleId: "b",
    });
    expect(startProgress([row("a")])).toEqual({
      followed: true,
      dossierFilled: false,
      dossierSaleId: "a",
    });
  });

  it("compte un statut ou un plafond supérieur à 0 € comme un dossier rempli", () => {
    expect(startProgress([row("a", null, 185_000)]).dossierFilled).toBe(true);
    expect(startProgress([row("a", "won")]).dossierFilled).toBe(true);
  });

  it("ne compte pas un plafond de 0 € (ancienne saisie)", () => {
    expect(startProgress([row("a", null, 0)]).dossierFilled).toBe(false);
  });

  it("ouvre le premier favori quand tous les dossiers sont remplis", () => {
    expect(startProgress([row("a", "bidding"), row("b", "watching")]).dossierSaleId).toBe("a");
  });
});

describe("startSteps", () => {
  const none = { followed: false, dossierFilled: false, dossierSaleId: null };

  it("masque la ligne du rappel tant que l'envoi est fermé", () => {
    const steps = startSteps(none, { available: false, enabled: false });
    expect(steps.map((step) => step.id)).toEqual(["follow", "dossier"]);
  });

  it("propose la ligne du rappel quand l'envoi est ouvert, et la garde cochée si déjà consentie", () => {
    expect(startSteps(none, { available: true, enabled: false }).at(-1)).toEqual({
      id: "reminder",
      done: false,
    });
    expect(startSteps(none, { available: false, enabled: true }).at(-1)).toEqual({
      id: "reminder",
      done: true,
    });
  });

  it("est terminée quand toutes les lignes affichées sont faites", () => {
    const done = { followed: true, dossierFilled: true, dossierSaleId: "a" };
    expect(startComplete(startSteps(done, { available: false, enabled: false }))).toBe(true);
    expect(startComplete(startSteps(done, { available: true, enabled: false }))).toBe(false);
    expect(startComplete(startSteps(done, { available: true, enabled: true }))).toBe(true);
    expect(startComplete(startSteps(none, { available: false, enabled: false }))).toBe(false);
  });
});

describe("fermeture de la carte", () => {
  it("se mémorise par compte", () => {
    expect(readStartCardClosed("u1")).toBe(false);
    writeStartCardClosed("u1");
    expect(readStartCardClosed("u1")).toBe(true);
    expect(readStartCardClosed("u2")).toBe(false);
    expect(window.localStorage.getItem(startCardClosedKey("u1"))).toBe("1");
  });

  it("résiste à un stockage inaccessible", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readStartCardClosed("u1")).toBe(false);
    expect(() => writeStartCardClosed("u1")).not.toThrow();
  });
});
