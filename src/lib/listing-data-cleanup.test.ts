import { describe, expect, it } from "vitest";
import { sanitizeAuctionSaleForDisplay } from "./listing-data-cleanup";
import type { AuctionSale } from "./types";

const department = (values: Partial<AuctionSale>) =>
  sanitizeAuctionSaleForDisplay(values as AuctionSale).department;

describe("sanitizeAuctionSaleForDisplay department", () => {
  it("keeps the Corsican department letters derived from the postal code", () => {
    expect(department({ department: "2A", postal_code: "20000" })).toBe("2A");
    expect(department({ department: "2B", postal_code: "20200" })).toBe("2B");
    expect(department({ department: "20", postal_code: "20090" })).toBe("2A");
    expect(department({ department: null, postal_code: "20600" })).toBe("2B");
  });

  it("derives overseas departments with the shared postal-code rule", () => {
    expect(department({ department: "974", postal_code: "97400" })).toBe("974");
    expect(department({ department: "97", postal_code: "97200" })).toBe("972");
    expect(department({ department: null, postal_code: "98800" })).toBe("988");
    expect(department({ department: null, postal_code: "98714" })).toBe("987");
  });
});
