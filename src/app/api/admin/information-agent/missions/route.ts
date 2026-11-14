import { NextResponse } from "next/server";
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
    guard: "admin",
  },
  async (request, { auth }) => {
    const input = informationAgentListQuerySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams.entries()),
    );
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
    guard: "admin",
  },
  async (request, { auth }) => {
    const input = informationAgentCreateSchema.parse(await request.json());
    const response = await createAdminInformationAgentDraft({ auth, input });
    return NextResponse.json(response, { status: 201 });
  },
);

export const PATCH = adminRoute(
  {
    scope: "admin.information-agent.missions.action",
    fallbackMessage: "Action sur la mission impossible",
    guard: "admin",
  },
  async (request, { auth }) => {
    const input = informationAgentAdminActionSchema.parse(await request.json());
    return runAdminInformationAgentAction({ auth, input });
  },
);
