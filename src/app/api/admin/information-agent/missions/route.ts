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
import { adminRoute } from "@/lib/admin-route-deadline";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

export const GET = adminRoute(
  {
    scope: "admin.information-agent.missions.read",
    fallbackMessage: "Missions indisponibles",
  },
  async (request) => {
    const input = adminInformationAgentListQuerySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams.entries()),
    );
    return listAdminInformationAgentMissionsForToken({
      authToken: bearerTokenFromRequest(request),
      saleId: input.saleId,
      offset: input.offset,
      limit: input.limit,
    });
  },
);

export const POST = adminRoute(
  {
    scope: "admin.information-agent.missions.create",
    fallbackMessage: "Mission non créée",
  },
  async (request) => {
    const authToken = bearerTokenFromRequest(request);
    const input = adminInformationAgentCreateSchema.parse(await request.json());
    const response = await createAdminInformationAgentMissionForToken({ authToken, input });
    return NextResponse.json(response, { status: 201 });
  },
);

export const PATCH = adminRoute(
  {
    scope: "admin.information-agent.missions.action",
    fallbackMessage: "Action sur la mission impossible",
  },
  async (request) => {
    const authToken = bearerTokenFromRequest(request);
    const input = adminInformationAgentActionSchema.parse(await request.json());
    return runAdminInformationAgentMissionActionForToken({ authToken, input });
  },
);
