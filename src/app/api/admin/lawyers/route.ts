import { NextResponse } from "next/server";
import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import {
  adminReferencedLawyerInputSchema,
  listAdminReferencedLawyers,
  saveAdminReferencedLawyer,
} from "@/lib/admin-lawyers";
import { adminErrorResponse } from "@/lib/api-route-errors";

export async function GET(request: Request) {
  try {
    const response = await listAdminReferencedLawyers(bearerTokenFromRequest(request));
    return NextResponse.json(response, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return adminErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const input = adminReferencedLawyerInputSchema.parse(await request.json());
    const response = await saveAdminReferencedLawyer({
      authToken: bearerTokenFromRequest(request),
      input,
    });
    return NextResponse.json(response, { status: input.id ? 200 : 201 });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
