// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUDIENCE_OPT_OUT_STORAGE_KEY,
  isAudienceOptedOut,
  setAudienceOptOut,
  subscribeAudienceOptOut,
} from "./audience-opt-out";

beforeEach(() => {
  window.localStorage.clear();
  setAudienceOptOut(false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("opposition à la mesure d'audience", () => {
  it("n'est pas activée par défaut", () => {
    expect(isAudienceOptedOut()).toBe(false);
  });

  it("mémorise le choix dans le navigateur et le retire", () => {
    setAudienceOptOut(true);
    expect(window.localStorage.getItem(AUDIENCE_OPT_OUT_STORAGE_KEY)).toBe("1");
    expect(isAudienceOptedOut()).toBe(true);

    setAudienceOptOut(false);
    expect(window.localStorage.getItem(AUDIENCE_OPT_OUT_STORAGE_KEY)).toBeNull();
    expect(isAudienceOptedOut()).toBe(false);
  });

  it("relit un choix mémorisé lors d'une visite précédente", () => {
    window.localStorage.setItem(AUDIENCE_OPT_OUT_STORAGE_KEY, "1");
    expect(isAudienceOptedOut()).toBe(true);
  });

  it("respecte le choix pendant l'onglet quand le stockage est inaccessible", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("stockage bloqué");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("stockage bloqué");
    });

    expect(() => setAudienceOptOut(true)).not.toThrow();
    expect(isAudienceOptedOut()).toBe(true);
  });

  it("ne lève pas d'erreur quand la lecture du stockage échoue", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("stockage bloqué");
    });
    expect(isAudienceOptedOut()).toBe(false);
  });

  it("prévient les abonnés d'un changement, dans cet onglet comme dans un autre", () => {
    const onChange = vi.fn();
    const unsubscribe = subscribeAudienceOptOut(onChange);

    setAudienceOptOut(true);
    expect(onChange).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new StorageEvent("storage", { key: AUDIENCE_OPT_OUT_STORAGE_KEY }));
    expect(onChange).toHaveBeenCalledTimes(2);

    window.dispatchEvent(new StorageEvent("storage", { key: "autre-clé" }));
    expect(onChange).toHaveBeenCalledTimes(2);

    unsubscribe();
    setAudienceOptOut(false);
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});
