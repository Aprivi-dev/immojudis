import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { apiError, apiJson, createApiRequestContext } from "@/lib/api-observability";
import {
  contractWithdrawalInputSchema,
  executeContractWithdrawal,
} from "@/lib/contract-withdrawal";
import { withAdminDeadline } from "@/lib/admin-route-deadline";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

async function handlePOST(request: Request) {
  const context = createApiRequestContext(request, "api.admin.privacy_requests.withdrawal");
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const input = contractWithdrawalInputSchema.parse(await request.json());
    return apiJson(await executeContractWithdrawal({ auth, input }), context);
  } catch (error) {
    return apiError(error, context, {
      fallbackMessage: "Rétractation impossible à exécuter.",
      fallbackStatus: 400,
    });
  }
}

export const POST = withAdminDeadline(handlePOST);
