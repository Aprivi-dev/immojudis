/**
 * Administrator multi-factor authentication helpers (plan P0-02). Browser-safe: no server imports.
 *
 * The server requirement is controlled by ADMIN_MFA_REQUIRED (default false) so that deploying the
 * code can never lock the administrator out before a TOTP factor is enrolled at /admin/securite.
 * The database mirrors it with app_private.security_switches.admin_mfa_required.
 */

export type AuthenticatorAssurance = {
  currentLevel: "aal1" | "aal2" | null;
  nextLevel: "aal1" | "aal2" | null;
};

export type MfaFactorSummary = {
  id: string;
  factor_type: string;
  status: string;
  friendly_name?: string | null;
};

/** True only when the operator explicitly turned the requirement on. */
export function isAdminMfaRequired(env: Pick<NodeJS.ProcessEnv, string> = process.env): boolean {
  return env.ADMIN_MFA_REQUIRED?.trim().toLowerCase() === "true";
}

/** The session level carried by a verified JWT; anything but aal2 counts as aal1. */
export function sessionAssuranceLevel(claims: Record<string, unknown>): "aal1" | "aal2" {
  return claims.aal === "aal2" ? "aal2" : "aal1";
}

/** Whether the administrator must enter a TOTP code before using the admin area. */
export function needsMfaChallenge(assurance: AuthenticatorAssurance | null): boolean {
  return assurance?.nextLevel === "aal2" && assurance.currentLevel === "aal1";
}

export function pickVerifiedTotpFactor(
  factors: readonly MfaFactorSummary[] | null | undefined,
): MfaFactorSummary | null {
  return (
    factors?.find((factor) => factor.factor_type === "totp" && factor.status === "verified") ?? null
  );
}

const TOTP_CODE_PATTERN = /^\d{6}$/;

/** Normalises what a user typed (spaces are common when copying from an app). */
export function normalizeTotpCode(value: string): string | null {
  const code = value.replace(/\s+/g, "");
  return TOTP_CODE_PATTERN.test(code) ? code : null;
}
