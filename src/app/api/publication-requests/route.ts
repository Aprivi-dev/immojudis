import { NextResponse } from "next/server";
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

const PRIVATE_AUTH_HEADERS = {
  "cache-control": "private, no-store",
  vary: "authorization",
};

export async function GET(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const page = parsePage(new URL(request.url).searchParams.get("page"));
    return NextResponse.json(await listPublicationRequests({ auth, page }), {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return errorResponse(error, { requests: [] }, "Demandes de publication indisponibles");
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const payload = publicationRequestFinalizeSchema.parse(await request.json());
    return NextResponse.json(await finalizePublicationRequest({ auth, ...payload }), {
      status: 201,
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return errorResponse(error, { request: null }, "Demande de publication impossible");
  }
}

export async function PUT(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const body = publicationUploadRequestSchema.parse(await request.json());
    return NextResponse.json(await createPublicationUploadTargets({ auth, files: body.files }), {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return errorResponse(error, { requestId: null, uploads: [] }, "Téléversement impossible");
  }
}

export async function DELETE(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const body = z.object({ requestId: z.string().uuid() }).parse(await request.json());
    await removePublicationRequestUploads({ auth, requestId: body.requestId });
    return NextResponse.json({ ok: true }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error, { ok: false }, "Nettoyage du téléversement impossible");
  }
}

function parsePage(value: string | null): number {
  if (!value) return 1;
  const page = Number(value);
  if (!Number.isInteger(page) || page < 1 || page > 100_000) {
    throw new Error("Page de demandes invalide");
  }
  return page;
}

function errorResponse(error: unknown, payload: Record<string, unknown>, fallback: string) {
  const message = error instanceof Error ? error.message : fallback;
  const status = message.startsWith("Unauthorized")
    ? 401
    : message.startsWith("Forbidden")
      ? 403
      : message.startsWith("NotFound")
        ? 404
        : 400;
  return NextResponse.json(
    { ...payload, error: message },
    { status, headers: PRIVATE_AUTH_HEADERS },
  );
}
