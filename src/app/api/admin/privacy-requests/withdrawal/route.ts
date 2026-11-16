import { z } from "zod";
import { adminRoute } from "@/lib/admin-route-deadline";
import {
  contractWithdrawalInputSchema,
  executeContractWithdrawal,
  getContractWithdrawalContext,
} from "@/lib/contract-withdrawal";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

const querySchema = z.object({ requestId: z.string().guid() });

/** Objet de la rétractation et, pour un achat à l'unité, les faits dont dépend la décision. */
export const GET = adminRoute(
  {
    scope: "api.admin.privacy_requests.withdrawal_context",
    fallbackMessage: "Rétractation illisible.",
    guard: "admin",
  },
  async (request, { auth }) => {
    const { requestId } = querySchema.parse({
      requestId: new URL(request.url).searchParams.get("requestId"),
    });
    return getContractWithdrawalContext({ auth, requestId });
  },
);

export const POST = adminRoute(
  {
    scope: "api.admin.privacy_requests.withdrawal",
    fallbackMessage: "Rétractation impossible à exécuter.",
    guard: "admin",
  },
  async (request, { auth }) => {
    const input = contractWithdrawalInputSchema.parse(await request.json());
    return executeContractWithdrawal({ auth, input });
  },
);
