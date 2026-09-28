import { describe, expect, it, vi } from "vitest";
import {
  assertInformationAgentOutboundEnabled,
  buildInformationRequestDraft,
  createAdminInformationAgentDraft,
  detectInformationGaps,
  discoverInformationAgentContacts,
  informationAgentAdminActionSchema,
  informationAgentCreateSchema,
  runAdminInformationAgentAction,
  selectInformationAgentContact,
  selectDefaultInformationAgentQuestionKeys,
} from "@/lib/information-agent";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { AuctionSale } from "@/lib/types";

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: vi.fn(), rpc: vi.fn() },
}));

const emailMocks = vi.hoisted(() => ({ sendResendEmail: vi.fn() }));

vi.mock("@/lib/email-alerts", () => ({
  sendResendEmail: emailMocks.sendResendEmail,
}));

describe("supervised information agent", () => {
  it("keeps outbound email disabled until it is explicitly enabled", () => {
    expect(() => assertInformationAgentOutboundEnabled({ NODE_ENV: "test" })).toThrow("désactivé");
    expect(() =>
      assertInformationAgentOutboundEnabled({
        NODE_ENV: "test",
        INFORMATION_AGENT_OUTBOUND_ENABLED: "false",
      }),
    ).toThrow("désactivé");
    expect(() =>
      assertInformationAgentOutboundEnabled({
        NODE_ENV: "test",
        INFORMATION_AGENT_OUTBOUND_ENABLED: "true",
      }),
    ).not.toThrow();
  });

  it("blocks the admin send action before any mutation or network call", async () => {
    const query = {
      select: vi.fn(),
      eq: vi.fn(),
      is: vi.fn(),
      single: vi.fn().mockResolvedValue({
        data: { id: "22222222-2222-4222-8222-222222222222", status: "draft" },
        error: null,
      }),
      then: vi.fn((onFulfilled: (value: { data: never[]; error: null }) => unknown) =>
        Promise.resolve({ data: [], error: null }).then(onFulfilled),
      ),
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.is.mockReturnValue(query);
    vi.mocked(supabaseAdmin.from).mockReturnValue(query as never);
    const fetchImpl = vi.fn();
    vi.stubEnv("INFORMATION_AGENT_OUTBOUND_ENABLED", "false");
    try {
      await expect(
        runAdminInformationAgentAction({
          auth: { isAdmin: true, userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } as never,
          input: {
            action: "approve_and_send",
            missionId: "22222222-2222-4222-8222-222222222222",
            approvalConfirmed: true,
            recipientEmail: "contact@example.test",
            subject: "Informations complémentaires",
            bodyText: "Bonjour, merci de nous transmettre les informations du dossier.",
          },
          fetchImpl: fetchImpl as typeof fetch,
        }),
      ).rejects.toThrow("désactivé");
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(supabaseAdmin.from).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllEnvs();
      vi.mocked(supabaseAdmin.from).mockReset();
    }
  });

  it("rechecks the registry after approval and immediately before provider delivery", async () => {
    const missionId = "22222222-2222-4222-8222-222222222222";
    const saleId = "11111111-1111-4111-8111-111111111111";
    const caseId = "33333333-3333-4333-8333-333333333333";
    const mission: Record<string, unknown> = {
      id: missionId,
      user_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      sale_id: saleId,
      case_id: caseId,
      status: "draft",
      created_at: new Date(Date.now() - 60_000).toISOString(),
      recipient_email: "cabinet@example.test",
      recipient_name: "Me Dupont",
      reply_to_email: null,
      subject: "Demande de pièces",
      body_text: "Bonjour, pourriez-vous transmettre les pièces du dossier ?",
      question_keys: ["documents"],
      missing_information: ["documents"],
      metadata: {},
    };
    let contactReads = 0;

    class ApprovalQuery {
      constructor(private readonly table: string) {}

      select() {
        return this;
      }

      eq() {
        return this;
      }

      is() {
        return this;
      }

      in() {
        return this;
      }

      update(values: Record<string, unknown>) {
        Object.assign(mission, values);
        return this;
      }

      insert() {
        return this;
      }

      async single() {
        return {
          data: this.table === "information_agent_missions" ? { ...mission } : null,
          error: null,
        };
      }

      then(onFulfilled: (value: { data: unknown; error: null }) => unknown) {
        const blocked = this.table === "information_agent_contacts" && contactReads++ >= 4;
        const result =
          this.table === "information_agent_contacts"
            ? {
                data: blocked
                  ? [
                      {
                        scope_sale_id: saleId,
                        opposition_status: "opposed",
                        bounce_status: "none",
                      },
                    ]
                  : [],
                error: null,
              }
            : { data: null, error: null };
        return Promise.resolve(result).then(onFulfilled);
      }
    }

    vi.mocked(supabaseAdmin.from).mockReset();
    vi.mocked(supabaseAdmin.rpc).mockReset();
    emailMocks.sendResendEmail.mockReset();
    vi.mocked(supabaseAdmin.from).mockImplementation((table) => new ApprovalQuery(table) as never);
    vi.mocked(supabaseAdmin.rpc).mockImplementation((async (name: string) => {
      if (name === "approve_information_agent_mission_admin") {
        return {
          data: [
            {
              mission_id: missionId,
              case_id: caseId,
              approved_at: new Date().toISOString(),
              should_send: true,
              inbound_token: "44444444-4444-4444-8444-444444444444",
            },
          ],
          error: null,
        };
      }
      return { data: null, error: null };
    }) as never);
    emailMocks.sendResendEmail.mockResolvedValue({ id: "provider-message-id" });
    vi.stubEnv("INFORMATION_AGENT_OUTBOUND_ENABLED", "true");
    vi.stubEnv("RESEND_API_KEY", "test-resend-key");
    vi.stubEnv("INFORMATION_AGENT_EMAIL_FROM", "agent@example.test");
    vi.stubEnv("INFORMATION_AGENT_INBOUND_DOMAIN", "reply.example.test");
    vi.stubEnv(
      "INFORMATION_AGENT_PORTAL_SECRET",
      "portal-secret-that-is-at-least-32-characters-long",
    );
    vi.stubEnv("SITE_URL", "https://immojudis.example");

    try {
      await expect(
        runAdminInformationAgentAction({
          auth: { isAdmin: true, userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } as never,
          input: {
            action: "approve_and_send",
            missionId,
            approvalConfirmed: true,
            recipientEmail: "cabinet@example.test",
            recipientName: "Me Dupont",
            subject: "Demande de pièces",
            bodyText: "Bonjour, pourriez-vous transmettre les pièces du dossier ?",
          },
        }),
      ).rejects.toThrow("opposé");
      expect(contactReads).toBe(6);
      expect(emailMocks.sendResendEmail).not.toHaveBeenCalled();
      expect(mission.status).toBe("failed");
    } finally {
      vi.unstubAllEnvs();
      vi.mocked(supabaseAdmin.from).mockReset();
      vi.mocked(supabaseAdmin.rpc).mockReset();
      emailMocks.sendResendEmail.mockReset();
    }
  });

  it("detects the material gaps of an incomplete auction listing", () => {
    const gaps = detectInformationGaps(incompleteSale());

    expect(gaps.map((gap) => gap.key)).toEqual([
      "documents",
      "photos",
      "visit",
      "occupancy",
      "surface",
      "diagnostics",
      "composition",
      "sale_terms",
    ]);
    expect(selectDefaultInformationAgentQuestionKeys(gaps)).toEqual([
      "documents",
      "sale_terms",
      "visit",
      "occupancy",
    ]);
    expect(gaps.find((gap) => gap.key === "documents")).toMatchObject({
      priority: 100,
      blocking: true,
    });
  });

  it("does not invent default questions when no gap was identified", () => {
    expect(selectDefaultInformationAgentQuestionKeys([])).toEqual([]);
  });

  it("discovers contacts from collected source fields with provenance and avoids ambiguous auto-selection", () => {
    const candidates = discoverInformationAgentContacts({
      ...incompleteSale(),
      source_name: "info_encheres",
      source_url: "https://user:secret@example.test/vente/123?lot=1",
      lawyer_name: "Me Dupont",
      lawyer_contact: "Me Dupont <cabinet@example.test>",
      source_blocks: {
        notary_email: "etude@example.test",
        details: "Répondre à cabinet@example.test si besoin.",
      },
    });

    expect(candidates.map((candidate) => candidate.email)).toEqual([
      "cabinet@example.test",
      "etude@example.test",
    ]);
    expect(candidates[0]).toMatchObject({
      name: "Me Dupont",
      role: "lawyer",
      recipientKind: "source_lawyer",
      confidence: "high",
    });
    expect(candidates[0]?.provenance[0]).toMatchObject({
      kind: "sale_field",
      field: "lawyer_contact",
      sourceName: "info_encheres",
      sourceUrl: "https://example.test/vente/123?lot=1",
    });
    expect(selectInformationAgentContact(candidates)).toBeNull();
  });

  it("auto-selects one high-confidence source contact and deduplicates repeated evidence", () => {
    const candidates = discoverInformationAgentContacts({
      ...incompleteSale(),
      source_name: "avoventes",
      source_url: "https://example.test/vente/123",
      lawyer_name: "Me Martin",
      lawyer_contact: "cabinet@example.test",
      source_description: "Contact : cabinet@example.test",
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.provenance).toHaveLength(2);
    expect(selectInformationAgentContact(candidates)?.email).toBe("cabinet@example.test");
  });

  it("builds a transparent, bounded draft without disclosing bidding capacity", () => {
    const draft = buildInformationRequestDraft({
      sale: incompleteSale(),
      recipientName: "Maître Dupont",
      questionKeys: ["documents", "photos", "visit"],
    });

    expect(draft.subject).toBe("Appartement T3 à Bordeaux — précisions sur la vente");
    expect(draft.bodyText).toContain("service indépendant d’information");
    expect(draft.bodyText).toContain("Une réponse partielle nous aidera déjà");
    expect(draft.bodyText).toContain("Audience annoncée : 14 septembre 2026");
    expect(draft.bodyText).toContain("cahier des conditions de vente");
    expect(draft.bodyText).not.toContain("utilisateur intéressé");
    expect(draft.bodyText).not.toMatch(/plafond d.enchère|budget de l.utilisateur/i);
  });

  it("omits an unknown hearing date and uses a neutral greeting", () => {
    const draft = buildInformationRequestDraft({
      sale: { ...incompleteSale(), sale_date: null },
      questionKeys: ["documents"],
    });

    expect(draft.subject).not.toContain("Date à confirmer");
    expect(draft.bodyText).toContain("Madame, Monsieur,");
    expect(draft.bodyText).not.toContain("Audience annoncée");
    expect(draft.bodyText).not.toContain("Date à confirmer");
  });

  it("keeps a long sale title short in the email subject", () => {
    const draft = buildInformationRequestDraft({
      sale: {
        ...incompleteSale(),
        title:
          "Appartement situé dans un immeuble ancien avec dépendances et plusieurs lots à Bordeaux",
      },
      questionKeys: ["documents"],
    });

    expect(draft.subject.length).toBeLessThanOrEqual(100);
    expect(draft.subject).toContain("… — précisions sur la vente");
    expect(draft.bodyText).toContain("plusieurs lots à Bordeaux");
  });

  it("requires explicit admin approval for every send", () => {
    const base = {
      action: "approve_and_send",
      missionId: "22222222-2222-4222-8222-222222222222",
      recipientEmail: "cabinet@example.test",
      recipientName: "Maître Dupont",
      subject: "Demande de pièces",
      bodyText: "Bonjour, pourriez-vous transmettre les pièces du dossier ?",
    };

    expect(
      informationAgentAdminActionSchema.safeParse({
        ...base,
        approvalConfirmed: false,
      }).success,
    ).toBe(false);
    expect(informationAgentCreateSchema.safeParse({ saleId: base.missionId }).success).toBe(true);
  });

  it("accepts the admin send approval without a requester-email sharing flag", () => {
    const result = informationAgentAdminActionSchema.safeParse({
      action: "approve_and_send",
      missionId: "22222222-2222-4222-8222-222222222222",
      approvalConfirmed: true,
      recipientEmail: "cabinet@example.test",
      recipientName: "Maître Dupont",
      subject: "Demande de pièces",
      bodyText: "Bonjour, pourriez-vous transmettre les pièces du dossier ?",
    });

    expect(result.success).toBe(true);
  });

  it("rejects the admin draft workflow for non-admin auth", async () => {
    await expect(
      createAdminInformationAgentDraft({
        auth: { isAdmin: false } as never,
        input: { saleId: "11111111-1111-4111-8111-111111111111" },
      }),
    ).rejects.toThrow("Forbidden: accès administrateur requis.");
  });
});

function incompleteSale(): AuctionSale {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Appartement T3 à Bordeaux",
    property_type: "apartment",
    postal_code: "33000",
    city: "Bordeaux",
    tribunal: "Tribunal judiciaire de Bordeaux",
    sale_date: "2026-09-14T09:00:00.000Z",
    starting_price_eur: 85_000,
    documents: null,
    documents_rich: null,
    media: null,
    visit_dates: null,
    occupancy_status: null,
    app_surface_m2: null,
    habitable_surface_m2: null,
    carrez_surface_m2: null,
    land_surface_m2: null,
    app_surface_kind: null,
    surface_scope: null,
    rooms_count: null,
    sale_procedure: null,
  } as AuctionSale;
}
