import { NextResponse } from "next/server";
import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import {
  adminInformationAgentEmailTemplateActionSchema,
  getAdminInformationAgentEmailTemplateWorkspace,
  runAdminInformationAgentEmailTemplateAction,
} from "@/lib/admin-information-agent-email-template";
import { adminErrorResponse } from "@/lib/api-route-errors";

export async function GET(request: Request) {
  try {
    const response = await getAdminInformationAgentEmailTemplateWorkspace(
      bearerTokenFromRequest(request),
    );
    return NextResponse.json(response, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return adminErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const input = adminInformationAgentEmailTemplateActionSchema.parse(await request.json());
    const response = await runAdminInformationAgentEmailTemplateAction({
      authToken: bearerTokenFromRequest(request),
      input,
    });
    return NextResponse.json(response, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
