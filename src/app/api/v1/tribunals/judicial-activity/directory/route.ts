import { apiError, apiJson, createApiRequestContext } from "@/lib/api-observability";
import {
  tribunalJudicialActivityDirectoryQuerySchema,
  tribunalJudicialActivityDirectoryResponseSchema,
} from "@/lib/tribunal-judicial-activity-directory";
import { getTribunalJudicialActivityDirectory } from "@/lib/tribunal-judicial-activity-repository";

export async function GET(request: Request) {
  const context = createApiRequestContext(request, "tribunal.judicial_activity.directory");
  try {
    const url = new URL(request.url);
    const input = tribunalJudicialActivityDirectoryQuerySchema.parse(
      Object.fromEntries(url.searchParams.entries()),
    );
    const directory = tribunalJudicialActivityDirectoryResponseSchema.parse(
      await getTribunalJudicialActivityDirectory(input),
    );
    return apiJson(directory, context, {
      headers: {
        "cache-control": "public, s-maxage=300, stale-while-revalidate=600",
      },
    });
  } catch (error) {
    const response = apiError(error, context, {
      fallbackMessage: "Répertoire statistique des tribunaux temporairement indisponible.",
      fallbackStatus: 503,
    });
    response.headers.set("cache-control", "public, max-age=0, no-cache");
    return response;
  }
}
