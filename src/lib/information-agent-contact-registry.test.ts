import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertInformationAgentContactAllowed,
  isInformationAgentContactBlocked,
  loadInformationAgentContactRegistry,
  persistInformationAgentContactObservations,
} from "@/lib/information-agent";

const mocks = vi.hoisted(() => ({ from: vi.fn() }));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from },
}));

const SALE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_SALE_ID = "22222222-2222-4222-8222-222222222222";

type RegistryRow = {
  scope_sale_id: string | null;
  opposition_status: "unknown" | "none" | "opposed";
  bounce_status: "none" | "temporary" | "permanent";
};

function createQuery(result: { data: RegistryRow[] | null; error: Error | null }) {
  let data = result.data;
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    is: vi.fn(),
    upsert: vi.fn(),
    then: vi.fn((onFulfilled: (value: typeof result) => unknown) =>
      Promise.resolve({ data, error: result.error }).then(onFulfilled),
    ),
  };
  query.select.mockReturnValue(query);
  query.eq.mockImplementation((column: string, value: string) => {
    if (column === "scope_sale_id") {
      data = data?.filter((row) => row.scope_sale_id === value) ?? null;
    }
    return query;
  });
  query.is.mockImplementation((column: string, value: null) => {
    if (column === "scope_sale_id" && value === null) {
      data = data?.filter((row) => row.scope_sale_id === null) ?? null;
    }
    return query;
  });
  query.upsert.mockReturnValue(query);
  return query;
}

function setupQuery(result: { data: RegistryRow[] | null; error: Error | null }) {
  const queries: Array<ReturnType<typeof createQuery>> = [];
  mocks.from.mockImplementation(() => {
    const query = createQuery(result);
    queries.push(query);
    return query;
  });
  return { queries };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("information agent contact registry guard", () => {
  it("blocks global opposition and sale-scoped permanent bounces only where they apply", () => {
    expect(
      isInformationAgentContactBlocked(
        { scope_sale_id: null, opposition_status: "opposed", bounce_status: "none" },
        SALE_ID,
      ),
    ).toBe(true);
    expect(
      isInformationAgentContactBlocked(
        { scope_sale_id: SALE_ID, opposition_status: "none", bounce_status: "permanent" },
        SALE_ID,
      ),
    ).toBe(true);
    expect(
      isInformationAgentContactBlocked(
        { scope_sale_id: OTHER_SALE_ID, opposition_status: "opposed", bounce_status: "none" },
        SALE_ID,
      ),
    ).toBe(false);
    expect(
      isInformationAgentContactBlocked(
        { scope_sale_id: SALE_ID, opposition_status: "unknown", bounce_status: "temporary" },
        SALE_ID,
      ),
    ).toBe(false);
  });

  it("rejects an explicitly opposed contact before draft or approval writes", async () => {
    const setup = setupQuery({
      data: [{ scope_sale_id: SALE_ID, opposition_status: "opposed", bounce_status: "none" }],
      error: null,
    });

    await expect(
      assertInformationAgentContactAllowed({
        saleId: SALE_ID,
        email: "Cabinet@Example.test",
      }),
    ).rejects.toThrow("opposé");
    expect(mocks.from).toHaveBeenCalledWith("information_agent_contacts");
    expect(setup.queries).toHaveLength(2);
    expect(setup.queries[0].select).toHaveBeenCalledWith(
      "scope_sale_id, opposition_status, bounce_status",
    );
    expect(setup.queries[0].eq).toHaveBeenCalledWith("normalized_email", "cabinet@example.test");
    expect(setup.queries[0].is).toHaveBeenCalledWith("scope_sale_id", null);
    expect(setup.queries[1].eq).toHaveBeenCalledWith("scope_sale_id", SALE_ID);
  });

  it("rejects a permanently bounced contact", async () => {
    setupQuery({
      data: [{ scope_sale_id: null, opposition_status: "none", bounce_status: "permanent" }],
      error: null,
    });

    await expect(
      assertInformationAgentContactAllowed({
        saleId: SALE_ID,
        email: "cabinet@example.test",
      }),
    ).rejects.toThrow("rebond permanent");
  });

  it("allows an unrelated sale row and keeps registry errors fail-closed", async () => {
    setupQuery({
      data: [{ scope_sale_id: OTHER_SALE_ID, opposition_status: "opposed", bounce_status: "none" }],
      error: null,
    });
    await expect(
      assertInformationAgentContactAllowed({ saleId: SALE_ID, email: "cabinet@example.test" }),
    ).resolves.toBeUndefined();

    setupQuery({ data: null, error: new Error("registry unavailable") });
    await expect(
      loadInformationAgentContactRegistry("cabinet@example.test", SALE_ID),
    ).rejects.toThrow("registry unavailable");
  });

  it("keeps an archived sale scope addressable only from its original sale", async () => {
    setupQuery({
      data: [{ scope_sale_id: SALE_ID, opposition_status: "opposed", bounce_status: "none" }],
      error: null,
    });
    await expect(
      loadInformationAgentContactRegistry("cabinet@example.test", SALE_ID),
    ).resolves.toHaveLength(1);

    setupQuery({
      data: [{ scope_sale_id: SALE_ID, opposition_status: "opposed", bounce_status: "none" }],
      error: null,
    });
    await expect(
      loadInformationAgentContactRegistry("cabinet@example.test", OTHER_SALE_ID),
    ).resolves.toHaveLength(0);
  });

  it("records source observations with an insert-only conflict policy", async () => {
    const setup = setupQuery({ data: [], error: null });

    await persistInformationAgentContactObservations({
      saleId: SALE_ID,
      candidates: [
        {
          email: "cabinet@example.test",
          name: "Me Dupont",
          role: "lawyer",
          recipientKind: "source_lawyer",
          confidence: "high",
          score: 100,
          provenance: [
            {
              kind: "sale_field",
              field: "lawyer_contact",
              sourceName: "avoventes",
              sourceUrl: "https://example.test/vente/1",
            },
          ],
        },
      ],
    });

    expect(setup.queries[0].upsert).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          sale_id: SALE_ID,
          scope_sale_id: SALE_ID,
          email: "cabinet@example.test",
          role: "lawyer",
          verification_status: "source_observed",
          opposition_status: "unknown",
          bounce_status: "none",
          provenance: [
            {
              kind: "sale_field",
              field: "lawyer_contact",
              source_name: "avoventes",
              source_url: "https://example.test/vente/1",
            },
          ],
        }),
      ],
      { ignoreDuplicates: true, onConflict: "scope_sale_id,normalized_email" },
    );
  });

  it("does not write malformed observed addresses", async () => {
    await persistInformationAgentContactObservations({
      saleId: SALE_ID,
      candidates: [
        {
          email: "not-an-email",
          name: null,
          role: "source_contact",
          recipientKind: "source_contact",
          confidence: "low",
          score: 1,
          provenance: [],
        },
      ],
    });

    expect(mocks.from).not.toHaveBeenCalled();
  });
});
