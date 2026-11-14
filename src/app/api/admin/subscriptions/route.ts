import {
  adminSubscriptionGrantInputSchema,
  grantAdminSubscription,
  listAdminSubscriptions,
} from "@/lib/admin-subscriptions";
import { adminPageQuerySchema } from "@/lib/admin-page-query";
import { adminRoute } from "@/lib/admin-route-deadline";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

export const GET = adminRoute(
  { scope: "admin.subscriptions.read", fallbackMessage: "Erreur admin abonnement", guard: "admin" },
  async (request, { authToken }) => {
    const page = adminPageQuerySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams.entries()),
    );
    return listAdminSubscriptions(authToken, page);
  },
);

export const POST = adminRoute(
  {
    scope: "admin.subscriptions.grant",
    fallbackMessage: "Erreur admin abonnement",
    guard: "admin",
  },
  async (request, { authToken }) => {
    const input = adminSubscriptionGrantInputSchema.parse(await request.json());
    return grantAdminSubscription({ authToken, input });
  },
);
