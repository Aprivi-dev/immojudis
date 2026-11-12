import { PublicApiError } from "@/lib/api-errors";
import { apiRoute } from "@/lib/api-route";

const retired = apiRoute(
  { scope: "api.information-agent.retired", fallbackMessage: "Fonctionnalité indisponible." },
  async () => {
    throw new PublicApiError(
      "Cette fonctionnalité est désormais réservée à l’administration.",
      410,
    );
  },
);

export const GET = retired;
export const POST = retired;
export const PATCH = retired;
