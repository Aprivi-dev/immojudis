import { describe, expect, it, vi } from "vitest";
import type { PublicSupabaseClient } from "@/lib/supabase-public.server";

const mocks = vi.hoisted(() => ({ maybeSingle: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => {
  const query = { select: () => query, eq: () => query, maybeSingle: mocks.maybeSingle };
  return { supabaseAdmin: { from: () => query } };
});

import { isPublishedPepite, readStoredPepite } from "@/lib/sale-pepite.server";

const saleId = "11111111-1111-4111-8111-111111111111";
const missing = { code: "PGRST202", message: "Could not find the function" };

describe("lecture du repère Pépite d'une vente", () => {
  it("ne prend que `true` pour une pépite publiée, et remonte une fonction absente", async () => {
    const answering = (result: { data: unknown; error: unknown }) =>
      ({ rpc: vi.fn().mockResolvedValue(result) }) as unknown as PublicSupabaseClient;

    await expect(isPublishedPepite(answering({ data: true, error: null }), saleId)).resolves.toBe(
      true,
    );
    await expect(isPublishedPepite(answering({ data: null, error: null }), saleId)).resolves.toBe(
      false,
    );
    await expect(isPublishedPepite(answering({ data: null, error: missing }), saleId)).rejects.toBe(
      missing,
    );
  });

  it("lit la ligne privée, et remonte une table absente au lieu de « pas de pépite »", async () => {
    mocks.maybeSingle.mockResolvedValueOnce({
      data: { reason_codes: ["below_range", 3], details: { ratio: 0.7 }, evaluated_at: null },
      error: null,
    });
    await expect(readStoredPepite(saleId)).resolves.toEqual({
      reasonCodes: ["below_range"],
      details: { ratio: 0.7 },
      evaluatedAt: null,
    });

    const absent = { code: "42P01", message: "relation does not exist" };
    mocks.maybeSingle.mockResolvedValueOnce({ data: null, error: absent });
    await expect(readStoredPepite(saleId)).rejects.toBe(absent);
  });
});
