import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  missions: vi.fn(),
  calls: [] as Array<[string, ...unknown[]]>,
  upsert: vi.fn(),
  ip: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => {
  const query: Record<string, unknown> = {};
  for (const method of ["select", "ilike", "in", "neq", "gte", "lte"]) {
    query[method] = (...args: unknown[]) => {
      mocks.calls.push([method, ...args]);
      return query;
    };
  }
  query.limit = () => mocks.missions();
  return {
    supabaseAdmin: {
      from: (table: string) =>
        table === "information_agent_contacts" ? { upsert: mocks.upsert } : query,
      rpc: vi.fn(),
    },
  };
});
vi.mock("@/lib/email-alerts", () => ({ sendResendEmail: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ enforceIpRateLimit: mocks.ip }));

import {
  assertInformationAgentControllerIdentity,
  assertInformationAgentRecipientCooldown,
} from "./information-agent";
import {
  describeInformationAgentAddressOrigin,
  informationAgentControllerIdentity,
  informationAgentLegalFooterLines,
} from "./information-agent-compliance";
import { classifyInformationAgentReplyIntent } from "./information-agent-inbound";
import {
  buildInformationAgentOptOutUrl,
  createInformationAgentOptOutToken,
  parseOptOutEmail,
  verifyInformationAgentOptOutToken,
} from "./information-agent-opt-out";
import { GET as optOut } from "@/app/api/information-agent/opt-out/route";

const SECRET = "portal-secret-that-is-at-least-32-characters-long";

describe("one email per recipient per 30 days (P4-12)", () => {
  beforeEach(() => {
    mocks.calls.length = 0;
    mocks.missions.mockReset();
  });

  it("refuses a recipient already solicited in the last 30 days, whatever the sale", async () => {
    mocks.missions.mockResolvedValue({
      data: [{ id: "other", approved_at: "2026-10-01T10:00:00.000Z" }],
      error: null,
    });

    await expect(
      assertInformationAgentRecipientCooldown({
        email: "Cabinet@Example.test",
        missionId: "mission-2",
        now: new Date("2026-10-10T10:00:00.000Z"),
      }),
    ).rejects.toThrow("déjà été sollicité");

    const filters = Object.fromEntries(mocks.calls.map(([name, ...args]) => [name, args]));
    expect(filters.ilike).toEqual(["recipient_email", "cabinet@example.test"]);
    expect(filters.neq).toEqual(["id", "mission-2"]);
    expect(filters.gte).toEqual(["approved_at", "2026-09-10T10:00:00.000Z"]);
    // No sale filter: the window is global to the recipient.
    expect(mocks.calls.some(([, column]) => column === "sale_id")).toBe(false);
    expect(filters.in?.[1]).toEqual(["approved", "sending", "sent", "replied", "completed"]);
  });

  it("allows a recipient with no recent solicitation", async () => {
    mocks.missions.mockResolvedValue({ data: [], error: null });
    await expect(
      assertInformationAgentRecipientCooldown({ email: "new@example.test", missionId: "m" }),
    ).resolves.toBeUndefined();
  });

  it("only counts older approvals once this mission is approved, so concurrent sends are ordered", async () => {
    mocks.missions.mockResolvedValue({ data: [], error: null });
    await assertInformationAgentRecipientCooldown({
      email: "new@example.test",
      missionId: "m",
      approvedAt: "2026-10-10T09:00:00.000Z",
    });
    expect(mocks.calls).toContainEqual(["lte", "approved_at", "2026-10-10T09:00:00.000Z"]);
  });

  it("escapes LIKE wildcards in the address and propagates database errors", async () => {
    mocks.missions.mockResolvedValue({ data: null, error: new Error("db down") });
    await expect(
      assertInformationAgentRecipientCooldown({ email: "a_b@example.test", missionId: "m" }),
    ).rejects.toThrow("db down");
    expect(mocks.calls).toContainEqual(["ilike", "recipient_email", "a\\_b@example.test"]);
  });
});

describe("art. 14 GDPR prerequisites (P4-12)", () => {
  it("refuses to send without a configured data controller", () => {
    expect(informationAgentControllerIdentity({})).toBeNull();
    expect(() => assertInformationAgentControllerIdentity({})).toThrow("responsable de traitement");
    expect(() =>
      assertInformationAgentControllerIdentity({ NEXT_PUBLIC_LEGAL_ENTITY_NAME: "Immojudis SAS" }),
    ).toThrow("responsable de traitement");
    expect(
      informationAgentControllerIdentity({
        NEXT_PUBLIC_LEGAL_ENTITY_NAME: "Immojudis SAS",
        NEXT_PUBLIC_LEGAL_ENTITY_ADDRESS: "1 rue de la Paix",
        NEXT_PUBLIC_LEGAL_CONTACT_EMAIL: "dpo@immojudis.test",
      }),
    ).toEqual({
      name: "Immojudis SAS",
      address: "1 rue de la Paix",
      contactEmail: "dpo@immojudis.test",
    });
  });

  it("states where the address comes from and renders the full plain-text footer", () => {
    expect(
      describeInformationAgentAddressOrigin({
        sourceName: "Licitor",
        sourceUrl: "https://www.licitor.com/annonce/1",
      }),
    ).toContain("(Licitor, licitor.com)");
    expect(describeInformationAgentAddressOrigin({})).toContain("avis de vente judiciaire publié");

    const lines = informationAgentLegalFooterLines({
      controllerName: "Immojudis SAS",
      controllerAddress: "1 rue de la Paix",
      contactEmail: null,
      addressOrigin: "Origine X.",
      privacyUrl: "https://immojudis.com/privacy",
      optOutUrl: "https://immojudis.com/api/information-agent/opt-out?e=a&t=b",
    }).join("\n");
    expect(lines).toContain("Responsable de traitement : Immojudis SAS, 1 rue de la Paix");
    expect(lines).toContain("Origine X.");
    expect(lines).toContain("https://immojudis.com/privacy");
    expect(lines).toContain("opt-out?e=a&t=b");
  });
});

describe("one-click objection link (P4-12)", () => {
  beforeEach(() => {
    mocks.upsert.mockReset();
    mocks.ip.mockReset();
    mocks.ip.mockResolvedValue(undefined);
    mocks.upsert.mockResolvedValue({ error: null });
    vi.stubEnv("INFORMATION_AGENT_PORTAL_SECRET", SECRET);
  });

  it("signs the normalised address and rejects tampering", () => {
    const token = createInformationAgentOptOutToken("Cabinet@Example.test", SECRET);
    expect(verifyInformationAgentOptOutToken("cabinet@example.test", token, SECRET)).toBe(true);
    expect(verifyInformationAgentOptOutToken("other@example.test", token, SECRET)).toBe(false);
    expect(
      verifyInformationAgentOptOutToken("cabinet@example.test", token, "another-secret-value-123"),
    ).toBe(false);
    expect(verifyInformationAgentOptOutToken("cabinet@example.test", "zz", SECRET)).toBe(false);
  });

  it("records a global opposition on a valid click", async () => {
    const url = buildInformationAgentOptOutUrl({
      appUrl: "https://immojudis.com",
      email: "Cabinet@Example.test",
      secret: SECRET,
    });
    const response = await optOut(new Request(url));

    expect(response.status).toBe(200);
    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "cabinet@example.test",
        scope_sale_id: null,
        opposition_status: "opposed",
      }),
      { onConflict: "scope_sale_id,normalized_email" },
    );
    expect(await response.text()).toContain("Opposition enregistrée");
  });

  it("rejects a forged or incomplete link without touching the registry", async () => {
    const forged = new URL(
      buildInformationAgentOptOutUrl({
        appUrl: "https://immojudis.com",
        email: "a@example.test",
        secret: SECRET,
      }),
    );
    forged.searchParams.set("e", Buffer.from("victim@example.test").toString("base64url"));

    expect((await optOut(new Request(forged))).status).toBe(400);
    expect(
      (await optOut(new Request("https://immojudis.com/api/information-agent/opt-out"))).status,
    ).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(parseOptOutEmail("not base64!")).toBeNull();
  });
});

describe("human review of unrecognised replies (P4-12)", () => {
  it("trusts only an explicit opposition or an explicit agreement/answer", () => {
    expect(
      classifyInformationAgentReplyIntent("Merci de ne plus me contacter.", { hasEvidence: false }),
    ).toBe("opposition");
    expect(
      classifyInformationAgentReplyIntent("Oui, ci-joint le cahier des charges.", {
        hasEvidence: false,
      }),
    ).toBe("agreement");
    expect(
      classifyInformationAgentReplyIntent("D'accord, je vous envoie ça.", { hasEvidence: false }),
    ).toBe("agreement");
    expect(
      classifyInformationAgentReplyIntent("La surface est de 70 m².", { hasEvidence: true }),
    ).toBe("agreement");
  });

  it("sends everything else to a human", () => {
    for (const reply of [
      "Je verrai cela plus tard.",
      "Rappelez-moi demain.",
      "Quelle est l'origine de votre demande ?",
      "Non, je ne peux pas vous aider.",
      "Cessez vos envois svp",
      "",
    ]) {
      expect(classifyInformationAgentReplyIntent(reply, { hasEvidence: false }), reply).toBe(
        "ambiguous",
      );
    }
  });

  it("does not take an agreement out of a refusal", () => {
    expect(
      classifyInformationAgentReplyIntent("Non merci, je ne suis pas d'accord.", {
        hasEvidence: false,
      }),
    ).toBe("ambiguous");
  });
});
