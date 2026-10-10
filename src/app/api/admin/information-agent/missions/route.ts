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
import { adminErrorResponse } from "@/lib/api-route-errors";
import { withAdminDeadline } from "@/lib/admin-route-deadline";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

async function handleGET(request: Request) {
  try {
    const url = new URL(request.url);
    const input = adminInformationAgentListQuerySchema.parse(
      Object.fromEntries(url.searchParams.entries()),
    );
    const response = await listAdminInformationAgentMissionsForToken({
      authToken: bearerTokenFromRequest(request),
      saleId: input.saleId,
      offset: input.offset,
      limit: input.limit,
    });
    return NextResponse.json(response, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return adminErrorResponse(error);
  }
}

async function handlePOST(request: Request) {
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
    return adminErrorResponse(error);
  }
}

async function handlePATCH(request: Request) {
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
    return adminErrorResponse(error);
  }
}

export const GET = withAdminDeadline(handleGET);
export const POST = withAdminDeadline(handlePOST);
export const PATCH = withAdminDeadline(handlePATCH);
