import { beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimitError } from "@/lib/api-errors";

const mocks = vi.hoisted(() => ({ sign: vi.fn(), ip: vi.fn() }));

vi.mock("@/lib/information-agent-evidence-url", () => ({
  createApprovedEvidenceSignedUrl: mocks.sign,
}));
vi.mock("@/lib/rate-limit", () => ({ enforceIpRateLimit: mocks.ip }));

import { GET } from "./route";

const get = (path = "x") =>
  new Request(`https://immojudis.com/api/information-agent/evidence?path=${path}`);

describe("GET /api/information-agent/evidence", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.ip.mockResolvedValue(undefined);
  });

  it("redirects to the freshly signed URL without letting it be cached", async () => {
    mocks.sign.mockResolvedValue("https://signed.example/doc?t=1");
    const response = await GET(get("a/b/c.pdf"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://signed.example/doc?t=1");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.sign).toHaveBeenCalledWith("a/b/c.pdf");
  });

  it("answers a uniform 404 when nothing can be signed", async () => {
    mocks.sign.mockResolvedValue(null);
    const response = await GET(get());
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ ok: false, error: "Pièce introuvable." });
  });

  it("is rate limited per IP", async () => {
    mocks.ip.mockRejectedValue(new RateLimitError(undefined, 30));
    const response = await GET(get());
    expect(response.status).toBe(429);
    expect(mocks.sign).not.toHaveBeenCalled();
  });
});
