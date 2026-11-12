import { NextResponse } from "next/server";
import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import { assertAdminAuth } from "@/lib/admin-auth.server";
import { adminRoute } from "@/lib/admin-route-deadline";
import {
  listAdminInformationAgentMissions,
  runAdminInformationAgentAction,
} from "@/lib/information-agent";
import { createAdminInformationAgentDraft } from "@/lib/information-agent/draft";
import {
  informationAgentAdminActionSchema,
  informationAgentCreateSchema,
  informationAgentListQuerySchema,
} from "@/lib/information-agent/schemas";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

export const GET = adminRoute(
  {
    scope: "admin.information-agent.missions.read",
    fallbackMessage: "Missions indisponibles",
  },
  async (request) => {
    const input = informationAgentListQuerySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams.entries()),
    );
    const auth = await assertAdminAuth(bearerTokenFromRequest(request));
    return listAdminInformationAgentMissions({
      auth,
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
    const input = informationAgentCreateSchema.parse(await request.json());
    const auth = await assertAdminAuth(authToken);
    const response = await createAdminInformationAgentDraft({ auth, input });
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
    const input = informationAgentAdminActionSchema.parse(await request.json());
    const auth = await assertAdminAuth(authToken);
    return runAdminInformationAgentAction({ auth, input });
  },
);
