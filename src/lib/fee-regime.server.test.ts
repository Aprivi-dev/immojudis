import { describe, expect, it } from "vitest";
import { openFeeRegimesFromEnv } from "@/lib/fee-regime.server";

describe("openFeeRegimesFromEnv", () => {
  it("ouvre tous les régimes définis quand CEILING_FEE_REGIMES_OPEN est absente", () => {
    expect(openFeeRegimesFromEnv({})).toEqual(["tribunal", "notary_auction", "notary_online"]);
  });

  it("n'ouvre que les régimes listés quand la variable est présente, le tribunal toujours", () => {
    expect(openFeeRegimesFromEnv({ CEILING_FEE_REGIMES_OPEN: "notary_online" })).toEqual([
      "tribunal",
      "notary_online",
    ]);
    // Coupe-circuit : la liste « tribunal » ou vide ferme les ventes notariales.
    expect(openFeeRegimesFromEnv({ CEILING_FEE_REGIMES_OPEN: "tribunal" })).toEqual(["tribunal"]);
    expect(openFeeRegimesFromEnv({ CEILING_FEE_REGIMES_OPEN: "" })).toEqual(["tribunal"]);
  });

  it("lit process.env par défaut", () => {
    const before = process.env.CEILING_FEE_REGIMES_OPEN;
    try {
      process.env.CEILING_FEE_REGIMES_OPEN = "notary_auction";
      expect(openFeeRegimesFromEnv()).toEqual(["tribunal", "notary_auction"]);
      delete process.env.CEILING_FEE_REGIMES_OPEN;
      expect(openFeeRegimesFromEnv()).toEqual(["tribunal", "notary_auction", "notary_online"]);
    } finally {
      if (before === undefined) delete process.env.CEILING_FEE_REGIMES_OPEN;
      else process.env.CEILING_FEE_REGIMES_OPEN = before;
    }
  });
});
