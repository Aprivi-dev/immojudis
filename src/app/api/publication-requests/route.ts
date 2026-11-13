import { NextResponse } from "next/server";
import { apiRoute } from "@/lib/api-route";
import { z } from "zod";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import {
  createPublicationUploadTargets,
  finalizePublicationRequest,
  listPublicationRequests,
  publicationRequestFinalizeSchema,
  publicationUploadRequestSchema,
  removePublicationRequestUploads,
} from "@/lib/publication-requests";

export const GET = apiRoute(
  {
    scope: "api.publication-requests.list",
    fallbackMessage: "Demandes de publication indisponibles",
    emptyBody: { requests: [] },
  },
  async (request) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const page = parsePage(new URL(request.url).searchParams.get("page"));
    return listPublicationRequests({ auth, page });
  },
);

export const POST = apiRoute(
  {
    scope: "api.publication-requests.finalize",
    fallbackMessage: "Demande de publication impossible",
    emptyBody: { request: null },
  },
  async (request) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const payload = publicationRequestFinalizeSchema.parse(await request.json());
    return NextResponse.json(await finalizePublicationRequest({ auth, ...payload }), {
      status: 201,
    });
  },
);

export const PUT = apiRoute(
  {
    scope: "api.publication-requests.upload",
    fallbackMessage: "Téléversement impossible",
    emptyBody: { requestId: null, uploads: [] },
  },
  async (request) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const body = publicationUploadRequestSchema.parse(await request.json());
    return createPublicationUploadTargets({ auth, files: body.files });
  },
);

export const DELETE = apiRoute(
  {
    scope: "api.publication-requests.cleanup",
    fallbackMessage: "Nettoyage du téléversement impossible",
    emptyBody: { ok: false },
  },
  async (request) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const body = z.object({ requestId: z.string().guid() }).parse(await request.json());
    await removePublicationRequestUploads({ auth, requestId: body.requestId });
    return { ok: true };
  },
);

function parsePage(value: string | null): number {
  if (!value) return 1;
  const page = Number(value);
  if (!Number.isInteger(page) || page < 1 || page > 100_000) {
    throw new Error("Page de demandes invalide");
  }
  return page;
}
