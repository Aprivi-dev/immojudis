// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  forgetSaleForSignup,
  rememberedSaleForSignup,
  rememberSaleForSignup,
} from "@/lib/signup-return-sale";

const SALE = "/sales/0f8c3b9e-6a1d-4c2e-9b7a-2d5e8f1a3c4b";

beforeEach(() => window.sessionStorage.clear());
afterEach(() => vi.restoreAllMocks());

// Le refus d'une adresse extérieure est celui de `/login` (validation de `redirect`) : voir
// `src/app/login/login-page.test.tsx`, « S'inscrire » de l'en-tête.
describe("fiche retenue pour l'inscription", () => {
  it("rend l'adresse notée dans l'onglet, telle quelle", () => {
    rememberSaleForSignup(SALE);
    expect(rememberedSaleForSignup()).toBe(SALE);
  });

  it("efface l'adresse quand elle a servi", () => {
    rememberSaleForSignup(SALE);
    forgetSaleForSignup();
    expect(rememberedSaleForSignup()).toBeUndefined();
    expect(window.sessionStorage.length).toBe(0);
  });

  it("ne rend rien quand aucune fiche n'a été notée", () => {
    expect(rememberedSaleForSignup()).toBeUndefined();
  });

  it("garde la fiche pour l'onglet seulement (sessionStorage, pas localStorage)", () => {
    rememberSaleForSignup(SALE);
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(1);
  });

  it("sans stockage (navigation privée, accès refusé) : ni erreur, ni fiche", () => {
    vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => {
      throw new DOMException("Accès refusé", "SecurityError");
    });
    expect(() => rememberSaleForSignup(SALE)).not.toThrow();
    expect(rememberedSaleForSignup()).toBeUndefined();
    expect(() => forgetSaleForSignup()).not.toThrow();
  });

  it("stockage plein ou lecture refusée : ni erreur, ni fiche", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Stockage plein", "QuotaExceededError");
    });
    expect(() => rememberSaleForSignup(SALE)).not.toThrow();
    expect(rememberedSaleForSignup()).toBeUndefined();

    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("Accès refusé", "SecurityError");
    });
    expect(rememberedSaleForSignup()).toBeUndefined();
  });
});
