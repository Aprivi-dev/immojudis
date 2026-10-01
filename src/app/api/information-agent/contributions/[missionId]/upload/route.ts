import { NextResponse } from "next/server";
import {
  prepareContributionUploadSchema,
  prepareInformationAgentContributionUpload,
} from "@/lib/information-agent-contribution";
import {
  contributionErrorResponse,
  readContributionJson,
} from "@/lib/information-agent-contribution-route-error";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ missionId: string }> },
) {
  try {
    const { missionId } = await params;
    const input = prepareContributionUploadSchema.parse(await readContributionJson(request));
    const prepared = await prepareInformationAgentContributionUpload({ missionId, input });
    return NextResponse.json(prepared, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return contributionErrorResponse(error);
  }
}
