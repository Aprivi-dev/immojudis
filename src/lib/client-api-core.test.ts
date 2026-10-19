import { beforeEach, describe, expect, it, vi } from "vitest";

const lazy = vi.hoisted(() => ({
  hasSupabaseAuthHint: vi.fn(),
  getSupabase: vi.fn(),
}));

vi.mock("@/integrations/supabase/lazy", () => lazy);

import { authHeaders } from "./client-api-core";

describe("authHeaders", () => {
  beforeEach(() => {
    lazy.hasSupabaseAuthHint.mockReset();
    lazy.getSupabase.mockReset();
  });

  it("does not load supabase-js for an anonymous visitor", async () => {
    lazy.hasSupabaseAuthHint.mockReturnValue(false);

    await expect(authHeaders()).rejects.toThrow("Connexion requise.");
    expect(lazy.getSupabase).not.toHaveBeenCalled();
  });

  it("reads the stored session when there is one", async () => {
    lazy.hasSupabaseAuthHint.mockReturnValue(true);
    lazy.getSupabase.mockResolvedValue({
      auth: { getSession: async () => ({ data: { session: { access_token: "jeton" } } }) },
    });

    await expect(authHeaders()).resolves.toEqual({ Authorization: "Bearer jeton" });
  });

  it("still refuses when the hint was wrong and no session is found", async () => {
    lazy.hasSupabaseAuthHint.mockReturnValue(true);
    lazy.getSupabase.mockResolvedValue({
      auth: { getSession: async () => ({ data: { session: null } }) },
    });

    await expect(authHeaders()).rejects.toThrow("Connexion requise.");
  });
});
