import { NextResponse } from "next/server";
import {
  submitContributionSchema,
  submitInformationAgentContribution,
} from "@/lib/information-agent-contribution";
import {
  contributionErrorResponse,
  readContributionJson,
} from "@/lib/information-agent-contribution-route-error";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ missionId: string }> },
) {
  try {
    const { missionId } = await params;
    const input = submitContributionSchema.parse(await readContributionJson(request));
    const submitted = await submitInformationAgentContribution({ missionId, input });
    return NextResponse.json(
      {
        ok: true,
        messageId: submitted.messageId,
        assetCount: submitted.assetCount,
      },
      { status: 201, headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    return contributionErrorResponse(error);
  }
}
