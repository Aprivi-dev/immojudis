import { afterEach, describe, expect, it, vi } from "vitest";
import { assertPublicationDateIsPublishable } from "./admin-publication-requests";

afterEach(() => vi.useRealTimers());

describe("admin publication date validation", () => {
  it("compares the civil date in Paris and accepts an audience today", () => {
    vi.useFakeTimers();
    // 22:30 UTC is already the next civil day in Paris during October.
    vi.setSystemTime(new Date("2026-10-03T22:30:00.000Z"));

    expect(assertPublicationDateIsPublishable("2026-10-04")).toBe("2026-10-04");
    expect(() => assertPublicationDateIsPublishable("2026-10-03")).toThrow(
      "date de vente est passée",
    );
  });
});
