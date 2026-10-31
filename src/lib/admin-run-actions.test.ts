import { describe, expect, it } from "vitest";
import { SOURCE_OPTIONS } from "@/components/admin/AdminRunPanels";
import { adminRunRestartRequest } from "@/lib/admin-run-actions";
import type { AuctionRun } from "@/lib/admin.server";

function finishedRun(source: string): AuctionRun {
  return { status: "completed", source, summary: {} } as unknown as AuctionRun;
}

describe("admin collection sources", () => {
  it("lets a finished run of a current source be restarted", () => {
    expect(adminRunRestartRequest(finishedRun("licitor"))).toEqual({
      source: "licitor",
      mode: "collect",
    });
  });

  it.each(["vench", "petites_affiches"])("no longer offers the withdrawn source %s", (source) => {
    expect(adminRunRestartRequest(finishedRun(source))).toBeNull();
    expect(SOURCE_OPTIONS.map((option) => option.value)).not.toContain(source);
  });
});
