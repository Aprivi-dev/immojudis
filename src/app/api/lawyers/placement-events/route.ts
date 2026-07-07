import { NextResponse } from "next/server";
import {
  lawyerPlacementEventInputSchema,
  recordLawyerPlacementEvent,
} from "@/lib/lawyer-placement-events";

export async function POST(request: Request) {
  try {
    const input = lawyerPlacementEventInputSchema.parse(await request.json());
    return NextResponse.json(await recordLawyerPlacementEvent({ input }));
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Événement de placement avocat impossible";
    const status = message.includes("introuvable") ? 404 : 400;
    return NextResponse.json({ ok: false, recorded: false, error: message }, { status });
  }
}
