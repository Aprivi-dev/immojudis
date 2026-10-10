import "server-only";
import { asRecord } from "@/lib/guards";

const RESEND_AUTHENTICATION_RESULTS = [
  "pass",
  "fail",
  "gray",
  "processing_failed",
  "unknown",
] as const;
type ResendAuthenticationResult = (typeof RESEND_AUTHENTICATION_RESULTS)[number];
type NormalizedInboundAuthenticationResult = ResendAuthenticationResult | "missing";

export type InboundSenderAuthentication = {
  status: "pass" | "fail" | "unverified";
  spf: NormalizedInboundAuthenticationResult;
  dkim: NormalizedInboundAuthenticationResult;
  dmarc: NormalizedInboundAuthenticationResult;
};

type InboundReviewReason =
  | "sender_mismatch"
  | "sender_authentication_failed"
  | "sender_authentication_unverified";

export function normalizeInboundSenderAuthentication(value: unknown): InboundSenderAuthentication {
  const authentication = asRecord(value);
  const spf = normalizeInboundAuthenticationResult(authentication.spf);
  const dkim = normalizeInboundAuthenticationResult(authentication.dkim);
  const dmarc = normalizeInboundAuthenticationResult(authentication.dmarc);

  // DMARC passes when at least one aligned mechanism (SPF or DKIM) passes.
  // Do not require both mechanisms: legitimate forwarded or relayed mail can
  // fail one while still carrying a valid aligned result through the other.
  const hasAlignedAuthentication = dmarc === "pass" && (spf === "pass" || dkim === "pass");
  // A failed DMARC check, or failures from both alignment mechanisms, is an
  // explicit authentication failure. A single SPF/DKIM failure is compatible
  // with a passing DMARC result through the other aligned mechanism.
  const hasAuthenticationFailure = dmarc === "fail" || (spf === "fail" && dkim === "fail");

  return {
    status: hasAlignedAuthentication ? "pass" : hasAuthenticationFailure ? "fail" : "unverified",
    spf,
    dkim,
    dmarc,
  };
}

function normalizeInboundAuthenticationResult(
  value: unknown,
): NormalizedInboundAuthenticationResult {
  if (value === undefined || value === null) return "missing";
  return isResendAuthenticationResult(value) ? value : "unknown";
}

function isResendAuthenticationResult(value: unknown): value is ResendAuthenticationResult {
  return (
    typeof value === "string" &&
    (RESEND_AUTHENTICATION_RESULTS as readonly string[]).includes(value)
  );
}

export function inboundReviewReason({
  senderMatches,
  senderAuthentication,
}: {
  senderMatches: boolean;
  senderAuthentication: InboundSenderAuthentication;
}): InboundReviewReason | null {
  if (!senderMatches) return "sender_mismatch";
  if (senderAuthentication.status === "fail") return "sender_authentication_failed";
  if (senderAuthentication.status !== "pass") {
    return "sender_authentication_unverified";
  }
  return null;
}
