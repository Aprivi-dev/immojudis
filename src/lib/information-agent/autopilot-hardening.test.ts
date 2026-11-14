import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  role: "admin" as string | null,
  user: { banned_until: null, deleted_at: null } as Record<string, unknown> | null,
  userError: null as unknown,
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: mocks.role ? { user_role: mocks.role } : null,
            error: null,
          }),
        }),
      }),
    }),
    auth: {
      admin: {
        getUserById: async () => ({ data: { user: mocks.user }, error: mocks.userError }),
      },
    },
    rpc: vi.fn(),
  },
}));

import { candidateSourceKind } from "@/lib/information-agent/autopilot-candidates";
import { isActiveAdmin } from "@/lib/information-agent/autopilot-readiness";
import { sanitizeAutopilotEventDetails } from "@/lib/information-agent/autopilot-settings";

beforeEach(() => {
  mocks.role = "admin";
  mocks.user = { banned_until: null, deleted_at: null };
  mocks.userError = null;
});

describe("administrateur d'exécution", () => {
  it("actif : rôle admin, compte ni supprimé ni suspendu", async () => {
    expect(await isActiveAdmin("admin-1")).toBe(true);
    expect(await isActiveAdmin(null)).toBe(false);
  });

  it.each([
    ["rôle rétrogradé", () => (mocks.role = "user")],
    [
      "compte supprimé",
      () => (mocks.user = { deleted_at: "2026-11-01T00:00:00Z", banned_until: null }),
    ],
    [
      "compte suspendu",
      () => (mocks.user = { deleted_at: null, banned_until: "2099-01-01T00:00:00Z" }),
    ],
    ["compte introuvable", () => (mocks.user = null)],
    [
      "compte réellement introuvable (404 de l'API Auth)",
      () =>
        (mocks.userError = Object.assign(new Error("User not found"), {
          status: 404,
          code: "user_not_found",
        })),
    ],
  ])("inactif : %s", async (_label, arrange) => {
    arrange();
    expect(await isActiveAdmin("admin-1")).toBe(false);
  });

  it("lecture impossible (panne passagère de l'API Auth) : l'erreur remonte, ce n'est pas un « non » (T7)", async () => {
    // Un « non » arrêterait le pilote et remettrait à zéro l'horloge de la simulation ; une erreur fait échouer
    // le seul passage en cours, le suivant relit l'état.
    mocks.user = null;
    mocks.userError = Object.assign(new Error("Gateway Timeout"), { status: 504 });
    await expect(isActiveAdmin("admin-1")).rejects.toThrow("Gateway Timeout");
    mocks.userError = new Error("fetch failed");
    await expect(isActiveAdmin("admin-1")).rejects.toThrow("fetch failed");
  });

  it("une suspension échue ne compte plus", async () => {
    mocks.user = { deleted_at: null, banned_until: "2020-01-01T00:00:00Z" };
    expect(await isActiveAdmin("admin-1")).toBe(true);
  });
});

describe("origine de l'adresse retenue", () => {
  const listing = [{ kind: "sale_field" }, { kind: "source_block" }];

  it("sale_listing seulement quand toutes les provenances sont l'annonce", () => {
    expect(candidateSourceKind({ provenance: listing }, [])).toBe("sale_listing");
    expect(candidateSourceKind({ provenance: listing }, ["sale_listing"])).toBe("sale_listing");
    expect(
      candidateSourceKind(
        { source: { kind: "sale_listing" }, provenance: [{ kind: "source_block" }] },
        [],
      ),
    ).toBe("sale_listing");
  });

  it("l'origine réelle sinon, et null (refus) quand elle est absente", () => {
    expect(candidateSourceKind({ provenance: [{ kind: "agent_search" }] }, [])).toBe(
      "agent_search",
    );
    expect(candidateSourceKind({ provenance: [{ kind: "court_registry" }] }, [])).toBe(
      "court_registry",
    );
    expect(candidateSourceKind({ provenance: listing }, ["sale_listing", "admin_entry"])).toBe(
      "admin_entry",
    );
    expect(candidateSourceKind({ provenance: [] }, [])).toBeNull();
  });
});

describe("liste blanche du journal", () => {
  it("ne garde que les clés admises et neutralise « @ » dans toute chaîne", () => {
    const clean = sanitizeAutopilotEventDetails({
      code: "policy_rejected",
      saleId: "sale-1",
      contact: "avocat@cabinet.test",
      reason: "écrit à avocat@cabinet.test",
      failed: ["a@b.fr", "roundtrip"],
      skip_domain_cap: 2,
      error_draft_error: 1,
      message: "duplicate key avocat@cabinet.test",
    });
    expect(clean).toEqual({
      code: "policy_rejected",
      saleId: "sale-1",
      reason: "écrit à avocat(at)cabinet.test",
      failed: ["a(at)b.fr", "roundtrip"],
      skip_domain_cap: 2,
      // Erreurs du passage : un compte par code, jamais le message de l'erreur.
      error_draft_error: 1,
    });
    expect(JSON.stringify(clean)).not.toContain("@");
  });
});
