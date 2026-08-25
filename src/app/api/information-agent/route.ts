import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { apiError, apiJson, createApiRequestContext } from "@/lib/api-observability";
import {
  createInformationAgentDraft,
  informationAgentActionSchema,
  informationAgentCreateSchema,
  informationAgentListQuerySchema,
  listInformationAgentMissions,
  runInformationAgentAction,
} from "@/lib/information-agent";

export async function GET(request: Request) {
  const context = createApiRequestContext(request, "api.information-agent.list");
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const url = new URL(request.url);
    const input = informationAgentListQuerySchema.parse(
      Object.fromEntries(url.searchParams.entries()),
    );
    const response = await listInformationAgentMissions({ auth, saleId: input.saleId });
    return apiJson(response, context, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return apiError(error, context, {
      fallbackMessage: "Enquêtes dossier indisponibles.",
    });
  }
}

export async function POST(request: Request) {
  const context = createApiRequestContext(request, "api.information-agent.create");
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const input = informationAgentCreateSchema.parse(await request.json());
    const response = await createInformationAgentDraft({ auth, input });
    return apiJson(response, context, {
      status: 201,
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return apiError(error, context, {
      fallbackMessage: "Préparation de l'enquête impossible.",
      headers: { "retry-after": "60" },
    });
  }
}

export async function PATCH(request: Request) {
  const context = createApiRequestContext(request, "api.information-agent.action");
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const input = informationAgentActionSchema.parse(await request.json());
    const response = await runInformationAgentAction({ auth, input });
    return apiJson(response, context, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return apiError(error, context, {
      fallbackMessage: "Action sur l'enquête impossible.",
      headers: { "retry-after": "60" },
    });
  }
}
