import { NextResponse } from "next/server";
import { z } from "zod";
import {
  informationAgentContributionPage,
  loadInformationAgentContribution,
} from "@/lib/information-agent-contribution";
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
    const session = await loadInformationAgentContribution(missionId, token);
    return NextResponse.json(informationAgentContributionPage(session), {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return contributionErrorResponse(error, "contribution.session");
  }
}
