import { NextResponse } from "next/server";
import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import {
  adminInformationAgentActionSchema,
  adminInformationAgentCreateSchema,
  adminInformationAgentListQuerySchema,
  createAdminInformationAgentMissionForToken,
  listAdminInformationAgentMissionsForToken,
  runAdminInformationAgentMissionActionForToken,
} from "@/lib/admin-information-agent";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const input = adminInformationAgentListQuerySchema.parse(
      Object.fromEntries(url.searchParams.entries()),
    );
    const response = await listAdminInformationAgentMissionsForToken({
      authToken: bearerTokenFromRequest(request),
      saleId: input.saleId,
    });
    return NextResponse.json(response, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return adminError(error);
  }
}

export async function POST(request: Request) {
  try {
    const input = adminInformationAgentCreateSchema.parse(await request.json());
    const response = await createAdminInformationAgentMissionForToken({
      authToken: bearerTokenFromRequest(request),
      input,
    });
    return NextResponse.json(response, {
      status: 201,
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return adminError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const input = adminInformationAgentActionSchema.parse(await request.json());
    const response = await runAdminInformationAgentMissionActionForToken({
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
