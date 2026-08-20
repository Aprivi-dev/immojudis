import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTribunalJudicialActivityDirectory } from "@/lib/tribunal-judicial-activity-directory";

const mocks = vi.hoisted(() => ({
  getDirectory: vi.fn(),
}));

vi.mock("@/lib/tribunal-judicial-activity-repository", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/tribunal-judicial-activity-repository")>();
  return { ...actual, getTribunalJudicialActivityDirectory: mocks.getDirectory };
});

import { GET } from "@/app/api/v1/tribunals/judicial-activity/directory/route";

const directory = buildTribunalJudicialActivityDirectory({
  courts: [],
  sales: [],
  asOf: new Date("2026-08-20T12:00:00.000Z"),
  historyMonths: 36,
});

function request(query = "?historyMonths=36") {
  return GET(
    new Request(`https://example.test/api/v1/tribunals/judicial-activity/directory${query}`),
  );
}

describe("GET /api/v1/tribunals/judicial-activity/directory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.getDirectory.mockResolvedValue(directory);
  });

  it("sert publiquement l’annuaire agrégé avec un cache partagé", async () => {
    const response = await request();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "public, s-maxage=300, stale-while-revalidate=600",
    );
    await expect(response.json()).resolves.toEqual(directory);
    expect(mocks.getDirectory).toHaveBeenCalledWith({ historyMonths: 36 });
  });

  it("refuse les paramètres inattendus avant toute lecture", async () => {
    const response = await request("?historyMonths=36&courtCode=paris");

    expect(response.status).toBe(400);
    expect(mocks.getDirectory).not.toHaveBeenCalled();
  });

  it("ne met pas durablement en cache une indisponibilité", async () => {
    mocks.getDirectory.mockRejectedValue(new Error("database unavailable"));

    const response = await request();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("public, max-age=0, no-cache");
  });
});
