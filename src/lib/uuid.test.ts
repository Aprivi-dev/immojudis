import { describe, expect, it } from "vitest";
import { isPersistedSale } from "@/lib/example-sale-identity";
import { isUuid, UUID_PATTERN, UUID_SOURCE } from "@/lib/uuid";

describe("isUuid", () => {
  it("accepte tout UUID hexadécimal, en minuscules ou en majuscules, sans exiger de version", () => {
    expect(isUuid("0f8fad5b-d9cb-469f-a165-70867728950e")).toBe(true);
    expect(isUuid("0F8FAD5B-D9CB-469F-A165-70867728950E")).toBe(true);
    expect(isUuid("00000000-0000-0000-0000-000000000000")).toBe(true);
    expect(isUuid("0f8fad5b-d9cb-769f-c165-70867728950e")).toBe(true);
  });

  it("refuse le reste", () => {
    for (const value of [
      null,
      undefined,
      42,
      "",
      "example-immojudis-1",
      " 0f8fad5b-d9cb-469f-a165-70867728950e",
      "0f8fad5b-d9cb-469f-a165-70867728950",
      "0f8fad5b-d9cb-469f-a165-70867728950e/extra",
    ]) {
      expect(isUuid(value), String(value)).toBe(false);
    }
  });

  it("partage le même motif avec les expressions qui l'emboîtent", () => {
    expect(UUID_PATTERN.source).toBe(`^${UUID_SOURCE}$`);
    expect(
      new RegExp(`^/sales/(${UUID_SOURCE})$`, "i").test(
        "/sales/0f8fad5b-d9cb-469f-a165-70867728950e",
      ),
    ).toBe(true);
  });
});

describe("isPersistedSale", () => {
  it("distingue une vente du catalogue d'une vente d'exemple", () => {
    expect(isPersistedSale({ id: "0f8fad5b-d9cb-469f-a165-70867728950e" })).toBe(true);
    expect(isPersistedSale({ id: "example-immojudis-bordeaux" })).toBe(false);
    expect(isPersistedSale({ id: "demo-v1" })).toBe(false);
  });
});
