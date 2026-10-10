import { NextResponse } from "next/server";
import { summarizeCspReports } from "@/lib/csp-reports";

const MAX_REPORT_BYTES = 16 * 1024;
const MAX_LOGGED_PER_WINDOW = 60;
const WINDOW_MS = 60_000;

let windowStartedAt = 0;
let loggedInWindow = 0;

/**
 * Collects CSP violation reports (report-uri / report-to) into the server logs, where the
 * log drain or the error tracker picks them up. Public by nature, so it is size-capped,
 * sampled per instance and never persists or echoes anything.
 */
export async function POST(request: Request) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_REPORT_BYTES) {
    return new NextResponse(null, { status: 413 });
  }

  const body = await request.text().catch(() => "");
  if (!body || body.length > MAX_REPORT_BYTES) {
    return new NextResponse(null, { status: body ? 413 : 204 });
  }

  const now = Date.now();
  if (now - windowStartedAt > WINDOW_MS) {
    windowStartedAt = now;
    loggedInWindow = 0;
  }
  if (loggedInWindow < MAX_LOGGED_PER_WINDOW) {
    for (const report of summarizeCspReports(body)) {
      if (loggedInWindow >= MAX_LOGGED_PER_WINDOW) break;
      loggedInWindow += 1;
      console.warn(JSON.stringify({ scope: "csp-report", ...report }));
    }
  }

  return new NextResponse(null, { status: 204, headers: { "cache-control": "no-store" } });
}
