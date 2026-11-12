import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { adminRoute } from "@/lib/admin-route-deadline";
import {
  contractWithdrawalInputSchema,
  executeContractWithdrawal,
} from "@/lib/contract-withdrawal";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

export const POST = adminRoute(
  {
    scope: "api.admin.privacy_requests.withdrawal",
    fallbackMessage: "Rétractation impossible à exécuter.",
  },
  async (request) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const input = contractWithdrawalInputSchema.parse(await request.json());
    return executeContractWithdrawal({ auth, input });
  },
);
