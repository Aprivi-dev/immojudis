import { describe, expect, it } from "vitest";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { emptyPilotDraft } from "@/lib/professional-pilots";
import { SaleWorkspaceConflictError, saveProfessionalPilot } from "@/lib/sale-workspaces";

const SALE_ID = "7d335032-e935-4550-9347-ed22b0f63449";
const USER_ID = "9b923d06-df18-403d-9c95-a4655f043825";
const INITIAL_VERSION = "2026-09-23T09:00:00.000Z";

function fakeAuth() {
  let revision = 0;
  let row = {
    id: "20f72e0b-f67f-43a4-b1bd-a53978cbdd83",
    user_id: USER_ID,
    sale_id: SALE_ID,
    updated_at: INITIAL_VERSION,
    private_notes: {},
    checklist: {},
    alert_preferences: {},
    document_reviews: {},
    tracking_status: "watching",
  };
  const from = () => {
    let mode: "read" | "update" = "read";
    let payload: Record<string, unknown> = {};
    const filters: Record<string, string> = {};
    const builder = {
      select: () => builder,
      update: (value: Record<string, unknown>) => {
        mode = "update";
        payload = value;
        return builder;
      },
      eq: (key: string, value: string) => {
        filters[key] = value;
        return builder;
      },
      maybeSingle: async () => {
        const matches =
          row.user_id === filters.user_id &&
          row.sale_id === filters.sale_id &&
          (!filters.updated_at || row.updated_at === filters.updated_at);
        if (!matches) return { data: null, error: null };
        if (mode === "update") {
          revision += 1;
          row = {
            ...row,
            private_notes: (payload.private_notes ?? {}) as typeof row.private_notes,
            updated_at: `2026-09-23T09:00:0${revision}.000Z`,
          };
        }
        return { data: { ...row }, error: null };
      },
    };
    return builder;
  };
  const auth = { userId: USER_ID, supabase: { from } } as unknown as SupabaseAuthContext;
  return { auth, current: () => row };
}

describe("professional pilot server revision", () => {
  it("rejects a later edit based on an obsolete workspace version", async () => {
    const fake = fakeAuth();
    await saveProfessionalPilot({
      auth: fake.auth,
      input: {
        saleId: SALE_ID,
        expectedUpdatedAt: INITIAL_VERSION,
        draft: { ...emptyPilotDraft("notary"), priceEur: 200_000 },
      },
    });

    await expect(
      saveProfessionalPilot({
        auth: fake.auth,
        input: {
          saleId: SALE_ID,
          expectedUpdatedAt: INITIAL_VERSION,
          draft: {
            ...emptyPilotDraft("notary"),
            priceEur: 250_000,
            updatedAt: "2026-09-23T10:00:00.000Z",
          },
        },
      }),
    ).rejects.toBeInstanceOf(SaleWorkspaceConflictError);
    expect(fake.current().private_notes).toMatchObject({
      professionalDossier: { priceEur: 200_000 },
    });
  });

  it("allows only one of two simultaneous saves from the same version", async () => {
    const fake = fakeAuth();
    const results = await Promise.allSettled(
      [180_000, 190_000].map((priceEur) =>
        saveProfessionalPilot({
          auth: fake.auth,
          input: {
            saleId: SALE_ID,
            expectedUpdatedAt: INITIAL_VERSION,
            draft: { ...emptyPilotDraft("state"), priceEur },
          },
        }),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });
});
