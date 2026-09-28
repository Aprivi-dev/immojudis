import { NextResponse } from "next/server";
import { z } from "zod";
import { loadInformationAgentContribution } from "@/lib/information-agent-contribution";
import {
  contributionErrorResponse,
  readContributionJson,
} from "@/lib/information-agent-contribution-route-error";

export const runtime = "nodejs";

const requestSchema = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/) });

export async function POST(
  request: Request,
  { params }: { params: Promise<{ missionId: string }> },
) {
  try {
    const { missionId } = await params;
    const { token } = requestSchema.parse(await readContributionJson(request));
    const { informationCase } = await loadInformationAgentContribution(missionId, token);
    return NextResponse.json(
      {
        caseReference: informationCase.id.slice(0, 8).toUpperCase(),
        subject: informationCase.subject,
        maxFileBytes: 20 * 1024 * 1024,
        maxSubmissionBytes: 40 * 1024 * 1024,
      },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    return contributionErrorResponse(error);
  }
}
