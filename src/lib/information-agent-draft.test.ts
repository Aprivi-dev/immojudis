import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminInformationAgentDraft } from "@/lib/information-agent";
import { DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE } from "@/lib/information-agent-email-template";
import type { AuctionSale } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  sale: vi.fn(),
  template: vi.fn(),
  claims: vi.fn(),
  send: vi.fn(),
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from, rpc: mocks.rpc },
}));
vi.mock("@/lib/admin-information-agent-sale", () => ({
  loadAdminInformationAgentSale: mocks.sale,
}));
vi.mock("@/lib/admin-information-agent-email-template", () => ({
  getPublishedInformationAgentEmailTemplate: mocks.template,
}));
vi.mock("@/lib/auction-fact-claims", () => ({ readSaleFactClaims: mocks.claims }));
vi.mock("@/lib/email-alerts", () => ({ sendResendEmail: mocks.send }));

const saleId = "11111111-1111-4111-8111-111111111111";
const admin = { isAdmin: true, userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } as never;
let inserted: Record<string, unknown> | null;

beforeEach(() => {
  vi.resetAllMocks();
  inserted = null;
  mocks.sale.mockResolvedValue({
    id: saleId,
    title: "Appartement Bordeaux",
    property_type: "apartment",
    address: "12 rue du Palais",
    city: "Bordeaux",
    postal_code: "33000",
    sale_date: null,
    starting_price_eur: null,
    lawyer_name: "Maître Dupont",
    lawyer_contact: "cabinet@example.test",
  } as AuctionSale);
  mocks.template.mockResolvedValue({
    id: "published-template",
    revision: 3,
    content: DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE,
  });
  mocks.claims.mockResolvedValue({ claims: [], claimsBacked: true });
  mocks.rpc.mockResolvedValue({ error: null });
  mocks.from.mockImplementation((table: string) => {
    const result = () => ({
      data:
        table === "information_agent_missions"
          ? {
              id: "22222222-2222-4222-8222-222222222222",
              status: "draft",
              case_id: null,
              ...inserted,
            }
          : [],
      error: null,
    });
    const query = {
      select: () => query,
      eq: () => query,
      is: () => query,
      upsert: () => query,
      insert: (values: Record<string, unknown>) => {
        inserted = values;
        return query;
      },
      single: async () => result(),
      then: (resolve: (value: ReturnType<typeof result>) => unknown) =>
        Promise.resolve(result()).then(resolve),
    };
    return query;
  });
});

describe("manual admin draft preparation", () => {
  it("prepares a complete targeted draft from only a sale id without approving or sending", async () => {
    const result = await createAdminInformationAgentDraft({ auth: admin, input: { saleId } });
    expect(result.mission).toMatchObject({
      recipientEmail: "cabinet@example.test",
      recipientName: "Maître Dupont",
      status: "draft",
    });
    expect(result.mission.bodyText).toContain("12 rue du Palais");
    expect(result.mission.bodyText).toContain("ImmoJudis est un service indépendant");
    expect(result.mission.bodyText).toContain("compte professionnel");
    expect(result.mission.bodyText).toContain("/login?mode=professional&redirect=%2Fespace-pro");
    expect(result.mission.bodyText).toContain("confirmer la date");
    expect(result.mission.questionKeys).toHaveLength(4);
    expect(
      result.mission.questionKeys.every((key) => result.gaps.some((gap) => gap.key === key)),
    ).toBe(true);
    expect(inserted).toMatchObject({ share_requester_email: false });
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("subscribe_information_agent_mission", {
      p_user_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      p_mission_id: "22222222-2222-4222-8222-222222222222",
    });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("never addresses a manual contact by an unrelated lawyer's name", async () => {
    const result = await createAdminInformationAgentDraft({
      auth: admin,
      input: { saleId, recipientEmail: "notaire@example.test" },
    });
    expect(result.mission.recipientName).toBeNull();
    expect(result.mission.bodyText).toContain("Madame, Monsieur,");
    expect(result.mission.bodyText).not.toContain("Maître Dupont");
  });

  it.each([null, "premier@example.test et second@example.test"])(
    "requires a manual choice when a recipient cannot be reliably selected (%s)",
    async (contact) => {
      const sale = await mocks.sale();
      mocks.sale.mockResolvedValue({ ...sale, lawyer_contact: contact });
      await expect(
        createAdminInformationAgentDraft({ auth: admin, input: { saleId } }),
      ).rejects.toThrow("Requête invalide");
      expect(inserted).toBeNull();
      expect(mocks.rpc).not.toHaveBeenCalled();
      expect(mocks.send).not.toHaveBeenCalled();
    },
  );
});
