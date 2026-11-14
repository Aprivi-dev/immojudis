import { NextResponse } from "next/server";
import {
  adminReferencedLawyerInputSchema,
  listAdminReferencedLawyers,
  saveAdminReferencedLawyer,
} from "@/lib/admin-lawyers";
import { adminRoute } from "@/lib/admin-route-deadline";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

export const GET = adminRoute(
  {
    scope: "admin.lawyers.read",
    fallbackMessage: "Avocats référencés indisponibles",
    guard: "admin",
  },
  async (_request, { authToken }) => listAdminReferencedLawyers(authToken),
);

export const POST = adminRoute(
  { scope: "admin.lawyers.write", fallbackMessage: "Avocat non enregistré", guard: "admin" },
  async (request, { authToken }) => {
    const input = adminReferencedLawyerInputSchema.parse(await request.json());
    const response = await saveAdminReferencedLawyer({ authToken, input });
    return NextResponse.json(response, { status: input.id ? 200 : 201 });
  },
);
