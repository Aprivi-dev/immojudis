// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const created = vi.hoisted(() => ({ evaluations: 0 }));
vi.mock("./client", () => {
  created.evaluations += 1;
  return { supabase: { marker: "client" } };
});

import {
  announceSupabaseClient,
  getSupabase,
  hasSupabaseAuthHint,
  onSupabaseClient,
  resetSupabaseLazyForTests,
  SUPABASE_AUTH_STORAGE_KEY,
  type SupabaseBrowserClient,
} from "./lazy";

afterEach(() => {
  resetSupabaseLazyForTests();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  created.evaluations = 0;
  vi.restoreAllMocks();
});

describe("hasSupabaseAuthHint", () => {
  it("est faux pour un visiteur anonyme", () => {
    expect(hasSupabaseAuthHint()).toBe(false);
  });

  it("est vrai quand une session est stockée sous la clé du client", () => {
    window.localStorage.setItem(SUPABASE_AUTH_STORAGE_KEY, "{}");
    expect(hasSupabaseAuthHint()).toBe(true);
  });

  it("est vrai quand l'adresse porte un retour d'authentification", () => {
    for (const url of [
      "/login#access_token=a&refresh_token=b&type=recovery",
      "/login#error_description=expired",
      "/login?code=pkce-code",
      "/login?next=%2Fsales&code=pkce-code",
    ]) {
      window.history.replaceState(null, "", url);
      expect(hasSupabaseAuthHint(), url).toBe(true);
    }
  });

  it("ne confond pas un autre paramètre avec un retour d'authentification", () => {
    window.history.replaceState(null, "", "/sales?postcode=33000&barcode=1#encode=2");
    expect(hasSupabaseAuthHint()).toBe(false);
  });

  it("charge le client dans le doute quand le stockage est inaccessible", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(hasSupabaseAuthHint()).toBe(true);
  });
});

describe("getSupabase", () => {
  it("n'importe le client qu'au premier appel et le garde en mémoire", async () => {
    expect(created.evaluations).toBe(0);
    const [first, second] = await Promise.all([getSupabase(), getSupabase()]);
    expect(first).toBe(second);
    expect(first).toEqual({ marker: "client" });
    expect(created.evaluations).toBe(1);
  });

  it("rend tout de suite un client déjà annoncé", async () => {
    const client = { marker: "announced" } as unknown as SupabaseBrowserClient;
    announceSupabaseClient(client);
    await expect(getSupabase()).resolves.toBe(client);
  });
});

describe("onSupabaseClient", () => {
  it("prévient quand le client apparaît, puis plus après désabonnement", () => {
    const listener = vi.fn();
    const stop = onSupabaseClient(listener);
    expect(listener).not.toHaveBeenCalled();

    const client = { marker: "one" } as unknown as SupabaseBrowserClient;
    announceSupabaseClient(client);
    expect(listener).toHaveBeenCalledWith(client);

    stop();
    announceSupabaseClient({ marker: "two" } as unknown as SupabaseBrowserClient);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("journalise un écouteur qui lève sans empêcher les autres ni l'annonce", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = vi.fn(() => {
      throw new Error("écouteur cassé");
    });
    const healthy = vi.fn();
    onSupabaseClient(failing);
    onSupabaseClient(healthy);

    const client = { marker: "announced" } as unknown as SupabaseBrowserClient;
    expect(() => announceSupabaseClient(client)).not.toThrow();
    expect(healthy).toHaveBeenCalledWith(client);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      "[supabase] Écouteur du client en échec",
      expect.objectContaining({ message: "écouteur cassé" }),
    );
  });

  it("prévient tout de suite si le client existe déjà", () => {
    const client = { marker: "existing" } as unknown as SupabaseBrowserClient;
    announceSupabaseClient(client);
    const listener = vi.fn();
    onSupabaseClient(listener);
    expect(listener).toHaveBeenCalledWith(client);
  });
});
