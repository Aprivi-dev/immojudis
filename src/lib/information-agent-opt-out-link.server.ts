import "server-only";
import {
  normalizeOptOutEmail,
  parseOptOutEmail,
  verifyInformationAgentOptOutToken,
} from "@/lib/information-agent-opt-out";

export function verifiedOptOutLink(request: Request): { email: string } | null {
  const params = new URL(request.url).searchParams;
  const email = parseOptOutEmail(params.get("e"));
  const secret = process.env.INFORMATION_AGENT_PORTAL_SECRET?.trim() ?? "";
  if (!email || !verifyInformationAgentOptOutToken(email, params.get("t") ?? "", secret)) {
    return null;
  }
  return { email: normalizeOptOutEmail(email) };
}
