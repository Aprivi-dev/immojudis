import { NextResponse } from "next/server";
import { getSharedPropertyReport } from "@/lib/property-reports";

type RouteParams = {
  params: Promise<{ token: string }>;
};

export async function GET(_request: Request, { params }: RouteParams) {
  try {
    const { token } = await params;
    const report = await getSharedPropertyReport({ token });

    return NextResponse.json(
      { report },
      {
        headers: {
          "cache-control": "no-store",
        },
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Rapport partagé introuvable";
    return NextResponse.json({ ok: false, error: message }, { status: 404 });
  }
}
