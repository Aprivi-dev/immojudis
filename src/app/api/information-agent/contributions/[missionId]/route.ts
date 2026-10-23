import { NextResponse } from "next/server";
import { z } from "zod";
import {
  loadInformationAgentContribution,
  PORTAL_UPLOAD_QUOTA_BYTES,
  PORTAL_UPLOAD_QUOTA_FILES,
} from "@/lib/information-agent-contribution";
import { buildInformationAgentOptOutPath } from "@/lib/information-agent-opt-out";
import {
  contributionErrorResponse,
  readContributionJson,
} from "@/lib/information-agent-contribution-route-error";

const requestSchema = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/) });

export async function POST(
  request: Request,
  { params }: { params: Promise<{ missionId: string }> },
) {
  try {
    const { missionId } = await params;
    const { token } = requestSchema.parse(await readContributionJson(request));
    const { informationCase, mission } = await loadInformationAgentContribution(missionId, token);
    return NextResponse.json(
      {
        caseReference: informationCase.id.slice(0, 8).toUpperCase(),
        subject: informationCase.subject,
        // The questions as sent, so the contributor can answer without going back to the email.
        questions: questionsFromBody(mission.body_text),
        maxFileBytes: 20 * 1024 * 1024,
        maxSubmissionBytes: 40 * 1024 * 1024,
        maxPortalBytes: PORTAL_UPLOAD_QUOTA_BYTES,
        maxPortalFiles: PORTAL_UPLOAD_QUOTA_FILES,
        // Signed objection address for the recipient of this very mission (the one already in the
        // email footer). The page keeps it in memory; a missing secret never blocks the deposit.
        optOutPath: optOutPathFor(mission.recipient_email),
      },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    return contributionErrorResponse(error, "contribution.session");
  }
}

function questionsFromBody(bodyText: string | null | undefined): string[] {
  return [...(bodyText ?? "").matchAll(/^\s*[-•]\s+(.+)$/gm)]
    .map((match) => (match[1] ?? "").trim().slice(0, 400))
    .filter(Boolean)
    .slice(0, 8);
}

function optOutPathFor(recipientEmail: string): string | null {
  const secret = process.env.INFORMATION_AGENT_PORTAL_SECRET?.trim() ?? "";
  if (secret.length < 16) return null;
  try {
    return buildInformationAgentOptOutPath({ email: recipientEmail, secret });
  } catch {
    return null;
  }
}
