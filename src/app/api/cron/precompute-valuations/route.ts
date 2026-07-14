import { NextResponse } from "next/server";
import { runSaleValuationPrecomputeBatch } from "@/lib/sale-market-estimates";

export const maxDuration = 300;

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runSaleValuationPrecomputeBatch({
      limit: numberFromEnv("VALUATION_PRECOMPUTE_BATCH_LIMIT") ?? 25,
    });
    console.info("[valuation-precompute] batch completed", {
      scanned: result.scanned,
      claimed: result.claimed,
      ready: result.ready,
      insufficientData: result.insufficientData,
      failed: result.failed,
    });
    return NextResponse.json(
      {
        ok: true,
        ...result,
        schedule: request.headers.get("x-vercel-cron-schedule"),
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Valuation precompute cron failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

function numberFromEnv(name: string): number | undefined {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
