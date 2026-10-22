import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyInformationAgentOptOutToken } from "@/lib/information-agent-opt-out";
import { POST } from "./route";

const SECRET = "portal-secret-that-is-at-least-32-characters-long";
const TOKEN = "a".repeat(64);
const MISSION_ID = "22222222-2222-4222-8222-222222222222";

const mocks = vi.hoisted(() => ({ load: vi.fn() }));

vi.mock("@/lib/information-agent-contribution", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/information-agent-contribution")>()),
  loadInformationAgentContribution: mocks.load,
}));

function call() {
  return POST(
    new Request(`https://immojudis.test/api/information-agent/contributions/${MISSION_ID}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: TOKEN }),
    }),
    { params: Promise.resolve({ missionId: MISSION_ID }) },
  );
}

beforeEach(() => {
  mocks.load.mockReset();
  mocks.load.mockResolvedValue({
    informationCase: { id: "abcdef12-0000-4000-8000-000000000000", subject: "Informations" },
    mission: {
      id: MISSION_ID,
      recipient_email: "Cabinet@Example.test",
      body_text: "Bonjour,\n\n- Quelle est la date de visite ?\n- Le bien est-il libre ?\n\nMerci",
    },
  });
  vi.stubEnv("INFORMATION_AGENT_PORTAL_SECRET", SECRET);
});

afterEach(() => vi.unstubAllEnvs());

describe("information agent contribution session", () => {
  it("returns the signed objection path of the mission recipient, never an absolute URL", async () => {
    const response = await call();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json();
    expect(body.caseReference).toBe("ABCDEF12");
    expect(body.questions).toEqual(["Quelle est la date de visite ?", "Le bien est-il libre ?"]);
    expect(body.optOutPath).toMatch(/^\/api\/information-agent\/opt-out\?e=[\w-]+&t=[a-f0-9]{64}$/);
    const params = new URL(body.optOutPath, "https://immojudis.test").searchParams;
    const email = Buffer.from(params.get("e") ?? "", "base64url").toString("utf8");
    expect(email).toBe("cabinet@example.test");
    expect(verifyInformationAgentOptOutToken(email, params.get("t") ?? "", SECRET)).toBe(true);
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });

  it("omits the objection path, without failing the deposit, when the secret is missing", async () => {
    vi.stubEnv("INFORMATION_AGENT_PORTAL_SECRET", "");

    const response = await call();

    expect(response.status).toBe(200);
    expect((await response.json()).optOutPath).toBeNull();
  });

  it("does not leak the objection path when the token is rejected", async () => {
    const { InformationAgentContributionError } =
      await import("@/lib/information-agent-contribution");
    mocks.load.mockRejectedValue(
      new InformationAgentContributionError("Lien de dépôt invalide ou expiré.", 404),
    );

    const response = await call();

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Lien de dépôt invalide ou expiré." });
  });
});
