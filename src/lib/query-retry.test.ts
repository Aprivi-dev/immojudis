import { describe, expect, it } from "vitest";
import { retryUnlessRefused } from "./query-retry";
import { SearchRejectedError } from "./search/search-errors";

describe("retryUnlessRefused", () => {
  it("retente une panne une fois", () => {
    expect(retryUnlessRefused(0, new Error("réseau"))).toBe(true);
    expect(retryUnlessRefused(1, new Error("réseau"))).toBe(false);
    expect(retryUnlessRefused(0, null)).toBe(true);
  });

  it("retente une panne serveur (503) ou un débit dépassé (429)", () => {
    expect(retryUnlessRefused(0, Object.assign(new Error("x"), { status: 503 }))).toBe(true);
    expect(retryUnlessRefused(0, Object.assign(new Error("x"), { status: 429 }))).toBe(true);
  });

  it("ne rejoue jamais une demande refusée (400) : la réponse serait la même", () => {
    expect(retryUnlessRefused(0, new SearchRejectedError("Page hors limites."))).toBe(false);
    expect(retryUnlessRefused(0, new SearchRejectedError("Zone trop large."))).toBe(false);
    expect(retryUnlessRefused(0, Object.assign(new Error("x"), { status: 400 }))).toBe(false);
  });
});
