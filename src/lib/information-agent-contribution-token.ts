import { createHmac, timingSafeEqual } from "node:crypto";

const CONTRIBUTION_TOKEN_VERSION = "v1";
const CONTRIBUTION_TOKEN_LIFETIME_MS = 45 * 24 * 60 * 60 * 1000;

function signedPayload(missionId: string, createdAt: string): string {
  return `${CONTRIBUTION_TOKEN_VERSION}:${missionId}:${createdAt}`;
}

export function createInformationAgentContributionToken(
  missionId: string,
  createdAt: string,
  secret: string,
): string {
  if (!secret || !Number.isFinite(Date.parse(createdAt))) {
    throw new Error("Configuration du lien de dépôt invalide.");
  }
  return createHmac("sha256", secret).update(signedPayload(missionId, createdAt)).digest("hex");
}

export function verifyInformationAgentContributionToken({
  missionId,
  createdAt,
  token,
  secret,
  now = Date.now(),
}: {
  missionId: string;
  createdAt: string;
  token: string;
  secret: string;
  now?: number;
}): boolean {
  const created = Date.parse(createdAt);
  if (
    !secret ||
    !Number.isFinite(created) ||
    !Number.isFinite(now) ||
    now < created ||
    now - created > CONTRIBUTION_TOKEN_LIFETIME_MS ||
    !/^[a-f0-9]{64}$/.test(token)
  ) {
    return false;
  }
  const expected = createInformationAgentContributionToken(missionId, createdAt, secret);
  return timingSafeEqual(Buffer.from(token, "hex"), Buffer.from(expected, "hex"));
}
