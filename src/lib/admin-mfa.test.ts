import { describe, expect, it } from "vitest";
import {
  isAdminMfaRequired,
  needsMfaChallenge,
  normalizeTotpCode,
  pickVerifiedTotpFactor,
  sessionAssuranceLevel,
} from "./admin-mfa";

describe("admin MFA helpers", () => {
  it("keeps the requirement OFF unless ADMIN_MFA_REQUIRED is explicitly true", () => {
    expect(isAdminMfaRequired({})).toBe(false);
    expect(isAdminMfaRequired({ ADMIN_MFA_REQUIRED: "" })).toBe(false);
    expect(isAdminMfaRequired({ ADMIN_MFA_REQUIRED: "false" })).toBe(false);
    expect(isAdminMfaRequired({ ADMIN_MFA_REQUIRED: "1" })).toBe(false);
    expect(isAdminMfaRequired({ ADMIN_MFA_REQUIRED: " TRUE " })).toBe(true);
  });

  it("reads the session assurance level from the verified claims", () => {
    expect(sessionAssuranceLevel({ aal: "aal2" })).toBe("aal2");
    expect(sessionAssuranceLevel({ aal: "aal1" })).toBe("aal1");
    expect(sessionAssuranceLevel({})).toBe("aal1");
    expect(sessionAssuranceLevel({ aal: "AAL2" })).toBe("aal1");
  });

  it("asks for a code only when a factor can raise an aal1 session to aal2", () => {
    expect(needsMfaChallenge({ currentLevel: "aal1", nextLevel: "aal2" })).toBe(true);
    expect(needsMfaChallenge({ currentLevel: "aal2", nextLevel: "aal2" })).toBe(false);
    expect(needsMfaChallenge({ currentLevel: "aal1", nextLevel: "aal1" })).toBe(false);
    expect(needsMfaChallenge(null)).toBe(false);
  });

  it("selects only a verified TOTP factor", () => {
    expect(
      pickVerifiedTotpFactor([
        { id: "a", factor_type: "totp", status: "unverified" },
        { id: "b", factor_type: "phone", status: "verified" },
        { id: "c", factor_type: "totp", status: "verified" },
      ])?.id,
    ).toBe("c");
    expect(pickVerifiedTotpFactor([])).toBeNull();
    expect(pickVerifiedTotpFactor(undefined)).toBeNull();
  });

  it("accepts a six-digit code typed with spaces and rejects anything else", () => {
    expect(normalizeTotpCode("123 456")).toBe("123456");
    expect(normalizeTotpCode("12345")).toBeNull();
    expect(normalizeTotpCode("12345a")).toBeNull();
    expect(normalizeTotpCode("1234567")).toBeNull();
  });
});
