import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ip: vi.fn(),
  global: vi.fn(),
  send: vi.fn(),
  headers: new Headers({ "x-real-ip": "203.0.113.7" }),
}));

vi.mock("next/headers", () => ({ headers: async () => mocks.headers }));
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: mocks.send };
  },
}));
vi.mock("@/lib/rate-limit", () => ({
  enforceIpRateLimit: mocks.ip,
  enforceGlobalRateLimit: mocks.global,
}));

import { RateLimitError } from "@/lib/api-errors";
import { CONTACT_RATE_LIMITS } from "@/lib/rate-limit-policies";
import { sendContactMessage } from "./actions";

const form = () => {
  const data = new FormData();
  data.set("name", "Claire Martin");
  data.set("email", "claire@example.fr");
  data.set("subject", "erreur");
  data.set("message", "La date de la vente est inexacte sur cette fiche.");
  data.set("website", "");
  return data;
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("CONTACT_EMAIL_TO", "contact@immojudis.test");
  vi.stubEnv("CONTACT_EMAIL_FROM", "Immojudis <contact@immojudis.test>");
  mocks.ip.mockResolvedValue(undefined);
  mocks.global.mockResolvedValue(undefined);
  mocks.send.mockResolvedValue({ error: null });
});

describe("sendContactMessage : limiteur partagé du dépôt", () => {
  it("compte l'envoi par adresse puis pour tout le site, en base, puis envoie", async () => {
    const state = await sendContactMessage({ status: "idle" }, form());
    expect(state.status).toBe("sent");
    expect(mocks.ip).toHaveBeenCalledWith(
      expect.objectContaining({ bucketKey: "contact", ...CONTACT_RATE_LIMITS.perIp }),
    );
    const request = (mocks.ip.mock.calls[0][0] as { request: Request }).request;
    expect(request.headers.get("x-real-ip")).toBe("203.0.113.7");
    expect(mocks.global).toHaveBeenCalledWith({
      bucketKey: "contact",
      ...CONTACT_RATE_LIMITS.global,
    });
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it("refuse avec un message en français quand la limite est atteinte", async () => {
    mocks.ip.mockRejectedValue(new RateLimitError());
    const state = await sendContactMessage({ status: "idle" }, form());
    expect(state.status).toBe("error");
    expect(state.message).toContain("Trop de messages envoyés");
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("n'envoie rien, journalise et prévient quand la base du limiteur est indisponible", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.global.mockRejectedValue(new Error("Contrôle de débit indisponible."));
    const state = await sendContactMessage({ status: "idle" }, form());
    expect(state.status).toBe("error");
    expect(state.message).toContain("n’a pas pu être envoyé");
    expect(mocks.send).not.toHaveBeenCalled();
    expect(String(log.mock.calls[0]?.[0])).toContain("limiter_unavailable");
    log.mockRestore();
  });
});
