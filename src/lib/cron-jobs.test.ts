import { describe, expect, it } from "vitest";
import { operationalErrorMessage } from "@/lib/cron-jobs";

describe("operational cron errors", () => {
  it("preserves structured PostgREST errors for operators", () => {
    expect(
      operationalErrorMessage({
        message: "permission denied for table user_profiles",
        details: "service_role cannot select rows",
        hint: null,
        code: "42501",
      }),
    ).toBe("permission denied for table user_profiles · service_role cannot select rows · 42501");
  });

  it("keeps a safe fallback for opaque failures", () => {
    expect(operationalErrorMessage({ unexpected: true })).toBe("Scheduled job failed");
  });
});
