import { NextResponse } from "next/server";
import { runSmartAlertEvaluationBatch } from "@/lib/alert-matches";

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runSmartAlertEvaluationBatch({
      userLimit: numberFromEnv("SMART_ALERT_CRON_USER_LIMIT"),
      saleLimit: numberFromEnv("SMART_ALERT_CRON_SALE_LIMIT"),
    });

    return NextResponse.json(
      {
        ...result,
        schedule: request.headers.get("x-vercel-cron-schedule"),
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Smart alert cron failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

function numberFromEnv(name: string): number | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
