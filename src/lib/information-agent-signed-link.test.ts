import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigurationError } from "@/lib/api-errors";
import { verifyInformationAgentContributionToken } from "@/lib/information-agent-contribution-token";
import {
  buildInformationAgentOptOutUrl,
  INFORMATION_AGENT_PORTAL_SECRET_MIN_BYTES,
  informationAgentOptOutPath,
  informationAgentPortalSecret,
  informationAgentRightsPath,
  requireInformationAgentPortalSecret,
  verifiedSignedEmailLink,
  verifyInformationAgentOptOutToken,
} from "@/lib/information-agent-signed-link";

const SECRET = "known-portal-secret-for-signature-tests-0123456789";
const EMAIL = "  Cabinet.Durand@Example.TEST ";

afterEach(() => vi.unstubAllEnvs());

describe("liens signés de l'agent d'information", () => {
  // Jetons calculés avec le code d'avant le regroupement des liens signés. Ils sont déjà dans des emails
  // envoyés : changer la normalisation de l'adresse ou le contexte de signature les invaliderait.
  it("valide toujours un jeton d'opposition déjà envoyé", () => {
    const sent =
      "https://immojudis.com/api/information-agent/opt-out?e=Y2FiaW5ldC5kdXJhbmRAZXhhbXBsZS50ZXN0&t=4724d4be04324a8624c7ddeb7dacffc3182e486271c115df98b0d2f7fc1cbe47";
    expect(
      buildInformationAgentOptOutUrl({
        appUrl: "https://immojudis.com",
        email: EMAIL,
        secret: SECRET,
      }),
    ).toBe(sent);
    expect(
      verifyInformationAgentOptOutToken(
        "cabinet.durand@example.test",
        "4724d4be04324a8624c7ddeb7dacffc3182e486271c115df98b0d2f7fc1cbe47",
        SECRET,
      ),
    ).toBe(true);
    vi.stubEnv("INFORMATION_AGENT_PORTAL_SECRET", SECRET);
    expect(verifiedSignedEmailLink(new Request(sent))).toEqual({
      email: "cabinet.durand@example.test",
    });
  });

  it("valide toujours un jeton de dépôt déjà envoyé", () => {
    expect(
      verifyInformationAgentContributionToken({
        missionId: "11111111-1111-4111-8111-111111111111",
        createdAt: "2026-11-01T10:00:00.000Z",
        caseId: "22222222-2222-4222-8222-222222222222",
        recipientEmail: EMAIL,
        contributionTokenVersion: 1,
        token: "71a93f54fffbabccfebc8c5e8186f7d1c2183ef776b83d774e10c696aa48ae6f",
        secret: SECRET,
        now: Date.parse("2026-11-02T10:00:00.000Z"),
      }),
    ).toBe(true);
  });

  it("refuse un secret de moins de 32 octets, lu une seule fois pour l'envoi, le dépôt et l'opposition", () => {
    const short = "s".repeat(INFORMATION_AGENT_PORTAL_SECRET_MIN_BYTES - 1);
    expect(informationAgentPortalSecret({ INFORMATION_AGENT_PORTAL_SECRET: short })).toBeNull();
    expect(informationAgentPortalSecret({ INFORMATION_AGENT_PORTAL_SECRET: ` ${SECRET} ` })).toBe(
      SECRET,
    );
    expect(() =>
      requireInformationAgentPortalSecret({ INFORMATION_AGENT_PORTAL_SECRET: short }),
    ).toThrow(ConfigurationError);

    // Un lien signé avec un secret court n'est plus accepté (il l'était entre 16 et 31 octets).
    const sent = buildInformationAgentOptOutUrl({
      appUrl: "https://immojudis.com",
      email: EMAIL,
      secret: short,
    });
    expect(
      verifiedSignedEmailLink(new Request(sent), { INFORMATION_AGENT_PORTAL_SECRET: short }),
    ).toBeNull();
  });

  it("construit les chemins d'opposition et de droits de la même adresse signée", () => {
    const env = { INFORMATION_AGENT_PORTAL_SECRET: SECRET };
    const optOut = informationAgentOptOutPath(EMAIL, env);
    const rights = informationAgentRightsPath(EMAIL, env);
    expect(optOut).toMatch(/^\/api\/information-agent\/opt-out\?e=[\w-]+&t=[a-f0-9]{64}$/);
    expect(rights).toBe(optOut.replace("/opt-out?", "/rights?"));
    expect(() => informationAgentOptOutPath(EMAIL, {})).toThrow(ConfigurationError);
  });

  it("impose le même seuil que les scripts de vérification de l'environnement", () => {
    for (const script of ["verify-required-env.mjs", "verify-production-env.mjs"]) {
      const source = readFileSync(path.join(process.cwd(), "scripts", script), "utf8");
      expect(source).toContain(
        `INFORMATION_AGENT_PORTAL_SECRET_MIN_BYTES = ${INFORMATION_AGENT_PORTAL_SECRET_MIN_BYTES};`,
      );
    }
  });
});
