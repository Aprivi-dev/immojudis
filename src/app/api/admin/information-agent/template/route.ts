import { NextResponse } from "next/server";
import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import {
  adminInformationAgentEmailTemplateActionSchema,
  getAdminInformationAgentEmailTemplateWorkspace,
  runAdminInformationAgentEmailTemplateAction,
} from "@/lib/admin-information-agent-email-template";
import { adminErrorResponse } from "@/lib/api-route-errors";
import { withAdminDeadline } from "@/lib/admin-route-deadline";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

async function handleGET(request: Request) {
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

async function handlePOST(request: Request) {
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

export const GET = withAdminDeadline(handleGET);
export const POST = withAdminDeadline(handlePOST);
