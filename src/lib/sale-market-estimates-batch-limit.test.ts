import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { rpc: mocks.rpc } }));

import { runSaleValuationPrecomputeBatch } from "@/lib/sale-market-estimates";

describe("taille de lot du pré-calcul des estimations", () => {
  it("réclame 75 estimations par passe sans consigne, et 100 au plus", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "stop" } });

    await expect(runSaleValuationPrecomputeBatch()).rejects.toMatchObject({ code: "XX000" });
    expect(mocks.rpc.mock.calls[0][1]).toMatchObject({ p_limit: 75 });

    await expect(runSaleValuationPrecomputeBatch({ limit: 500 })).rejects.toBeTruthy();
    expect(mocks.rpc.mock.calls[1][1]).toMatchObject({ p_limit: 100 });
  });
});
