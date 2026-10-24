import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/department-pages.server", () => ({ tryLoadDepartmentCatalogue: vi.fn() }));

import type { DepartmentStats } from "@/lib/department-pages";
import { loadHomeDepartmentCount } from "./home-departments.server";

function catalogue(counts: Record<string, number>) {
  const departments = Object.fromEntries(
    Object.entries(counts).map(([code, upcomingCount]) => [
      code,
      { code, upcomingCount } as DepartmentStats,
    ]),
  );
  return { status: "ok" as const, catalogue: { generatedAt: "", departments } };
}

describe("loadHomeDepartmentCount", () => {
  it("counts the departments that have at least one upcoming sale", async () => {
    const load = async () => catalogue({ "33": 12, "69": 3, "2A": 0 });
    expect(await loadHomeDepartmentCount({ load })).toBe(2);
  });

  it("shows nothing when the catalogue is missing, empty or too slow", async () => {
    expect(await loadHomeDepartmentCount({ load: async () => ({ status: "error" }) })).toBeNull();
    expect(await loadHomeDepartmentCount({ load: async () => catalogue({}) })).toBeNull();
    const never = () => new Promise<never>(() => {});
    expect(await loadHomeDepartmentCount({ load: never, timeoutMs: 5 })).toBeNull();
  });
});
