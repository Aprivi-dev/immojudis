import { NextResponse } from "next/server";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import {
  deletePropertyReport,
  listPropertyReports,
  propertyReportUpdateSchema,
  updatePropertyReport,
} from "@/lib/property-reports";

type RouteParams = {
  params: Promise<{ id: string }>;
};

export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const response = await listPropertyReports({ auth });
    const report = response.reports.find((item) => item.id === id);
    if (!report) {
      return NextResponse.json({ ok: false, error: "Rapport introuvable" }, { status: 404 });
    }
    return NextResponse.json({ report, plan: response.plan });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Rapport indisponible";
    const status = message.startsWith("Unauthorized") ? 401 : 400;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}

export async function PATCH(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const input = propertyReportUpdateSchema.parse(await request.json());
    const response = await updatePropertyReport({ auth, reportId: id, input });
    return NextResponse.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Rapport impossible à modifier";
    const status = message.startsWith("Unauthorized") ? 401 : 400;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}

export async function DELETE(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const response = await deletePropertyReport({ auth, reportId: id });
    return NextResponse.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Rapport impossible à supprimer";
    const status = message.startsWith("Unauthorized") ? 401 : 400;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
