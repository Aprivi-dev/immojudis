import { NextResponse } from "next/server";
import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import {
  adminInformationAgentEmailTemplateActionSchema,
  getAdminInformationAgentEmailTemplateWorkspace,
  runAdminInformationAgentEmailTemplateAction,
} from "@/lib/admin-information-agent-email-template";

export async function GET(request: Request) {
  try {
    const response = await getAdminInformationAgentEmailTemplateWorkspace(
      bearerTokenFromRequest(request),
    );
    return NextResponse.json(response, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return adminError(error);
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
    return adminError(error);
  }
}

function adminError(error: unknown) {
  const message = error instanceof Error ? error.message : "Erreur admin";
  const status = message.startsWith("Unauthorized")
    ? 401
    : message.startsWith("Forbidden")
      ? 403
      : 400;
  return NextResponse.json({ error: message }, { status });
}
