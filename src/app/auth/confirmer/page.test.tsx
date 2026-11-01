import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/AuthLinkConfirmation", () => ({ AuthLinkConfirmation: () => null }));

import { metadata } from "./page";

describe("page /auth/confirmer", () => {
  it("n'est pas indexée et ne transmet pas son adresse (jeton) comme référent", () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(metadata.referrer).toBe("no-referrer");
  });
});
