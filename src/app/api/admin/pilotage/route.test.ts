import { beforeEach, describe, expect, it, vi } from "vitest";
import { unavailablePilotage, unavailableSaleReminderAccuracy } from "@/lib/admin-pilotage";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  accuracy: vi.fn(),
  feedback: vi.fn(),
  ceilings: vi.fn(),
  survey: vi.fn(),
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: (request: Request) => {
    const header = request.headers.get("authorization");
    if (!header) throw new Error("Unauthorized: No authorization header provided");
    return header.replace("Bearer ", "");
  },
}));
vi.mock("@/lib/admin-pilotage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admin-pilotage")>()),
  getAdminPilotage: mocks.get,
  getAdminSaleReminderAccuracy: mocks.accuracy,
}));

vi.mock("@/lib/admin-bid-ceilings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admin-bid-ceilings")>()),
  getAdminBidCeilings: mocks.ceilings,
}));

vi.mock("@/lib/admin-offer-opening-survey", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admin-offer-opening-survey")>()),
  getAdminOfferOpeningSurvey: mocks.survey,
}));

vi.mock("@/lib/admin-sale-signal-feedback", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admin-sale-signal-feedback")>()),
  getAdminSaleSignalFeedback: mocks.feedback,
}));

import { unavailableBidCeilings } from "@/lib/admin-bid-ceilings";
import { unavailableOfferOpeningSurvey } from "@/lib/admin-offer-opening-survey";
import { unavailableSaleSignalFeedback } from "@/lib/admin-sale-signal-feedback";
import { GET } from "./route";

const url = "https://example.test/api/admin/pilotage";

describe("GET /api/admin/pilotage", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.ceilings.mockResolvedValue(unavailableBidCeilings());
    mocks.survey.mockResolvedValue(unavailableOfferOpeningSurvey());
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("rend les agrégats sans cache, avec le jeton de l'administrateur", async () => {
    const saleReminders = {
      ...unavailableSaleReminderAccuracy(new Date("2026-11-03T06:00:00Z")),
      measuredReminders: 120,
      contradictedReminders: 1,
      contradictionRate: 1 / 120,
      verdict: "met" as const,
    };
    const signalFeedback = {
      ...unavailableSaleSignalFeedback(),
      generatedAt: "2026-11-03T06:00:00Z",
    };
    mocks.get.mockResolvedValue(unavailablePilotage());
    mocks.accuracy.mockResolvedValue(saleReminders);
    mocks.feedback.mockResolvedValue(signalFeedback);
    const bidCeilings = {
      generatedAt: "2026-11-03T06:00:00Z",
      windows: [
        { days: 7, accounts: 12, sales: 9, occurrences: 40 },
        { days: 30, accounts: 31, sales: 22, occurrences: 140 },
      ],
    };
    mocks.ceilings.mockResolvedValue(bidCeilings);

    const response = await GET(
      new Request(url, { headers: { authorization: "Bearer admin-token" } }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      ...unavailablePilotage(),
      saleReminders,
      signalFeedback,
      bidCeilings,
      offerOpeningSurvey: unavailableOfferOpeningSurvey(),
    });
    expect(mocks.ceilings).toHaveBeenCalledWith("admin-token", expect.any(Date));
    expect(mocks.get).toHaveBeenCalledWith("admin-token", expect.any(Date));
    expect(mocks.accuracy).toHaveBeenCalledWith("admin-token", expect.any(Date));
    expect(mocks.feedback).toHaveBeenCalledWith("admin-token", expect.any(Date));
  });

  it("garde le pilotage quand les retours sur les signaux sont illisibles : « non mesuré »", async () => {
    mocks.get.mockResolvedValue(unavailablePilotage());
    mocks.accuracy.mockResolvedValue(unavailableSaleReminderAccuracy(new Date()));
    mocks.feedback.mockRejectedValue(new Error("relation sale_signal_feedback does not exist"));

    const response = await GET(
      new Request(url, { headers: { authorization: "Bearer admin-token" } }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.signalFeedback).toEqual(unavailableSaleSignalFeedback());
    expect(JSON.stringify(body)).not.toContain("does not exist");
  });

  it("garde le pilotage quand les plafonds calculés sont illisibles : « non mesuré »", async () => {
    mocks.get.mockResolvedValue(unavailablePilotage());
    mocks.accuracy.mockResolvedValue(unavailableSaleReminderAccuracy(new Date()));
    mocks.feedback.mockResolvedValue(unavailableSaleSignalFeedback());
    mocks.ceilings.mockRejectedValue(new Error("function admin_pilotage_bid_ceilings failed"));

    const response = await GET(
      new Request(url, { headers: { authorization: "Bearer admin-token" } }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.bidCeilings).toEqual(unavailableBidCeilings());
    expect(JSON.stringify(body)).not.toContain("failed");
  });

  it("garde le pilotage quand les réponses du questionnaire sont illisibles : « non mesuré »", async () => {
    mocks.get.mockResolvedValue(unavailablePilotage());
    mocks.accuracy.mockResolvedValue(unavailableSaleReminderAccuracy(new Date()));
    mocks.feedback.mockResolvedValue(unavailableSaleSignalFeedback());
    mocks.survey.mockRejectedValue(new Error("function admin_offer_opening_survey_summary failed"));

    const response = await GET(
      new Request(url, { headers: { authorization: "Bearer admin-token" } }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.offerOpeningSurvey).toEqual(unavailableOfferOpeningSurvey());
    expect(JSON.stringify(body)).not.toContain("failed");
  });

  it("garde le pilotage quand la mesure des rappels échoue : « non mesuré »", async () => {
    mocks.get.mockResolvedValue(unavailablePilotage());
    mocks.accuracy.mockRejectedValue(new Error("lecture impossible"));
    mocks.feedback.mockResolvedValue(unavailableSaleSignalFeedback());

    const response = await GET(
      new Request(url, { headers: { authorization: "Bearer admin-token" } }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.windows).toEqual(unavailablePilotage().windows);
    expect(body.saleReminders).toMatchObject({
      measuredReminders: null,
      contradictionRate: null,
      verdict: "unavailable",
    });
    expect(JSON.stringify(body)).not.toContain("lecture impossible");
  });

  it("refuse sans jeton, sans rien lire", async () => {
    const response = await GET(new Request(url));

    expect(response.status).toBe(401);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("refuse un compte non administrateur", async () => {
    mocks.get.mockRejectedValue(new Error("Forbidden: accès administrateur requis."));
    mocks.accuracy.mockRejectedValue(new Error("Forbidden: accès administrateur requis."));
    mocks.feedback.mockRejectedValue(new Error("Forbidden: accès administrateur requis."));

    const response = await GET(
      new Request(url, { headers: { authorization: "Bearer user-token" } }),
    );

    expect(response.status).toBe(403);
  });
});
