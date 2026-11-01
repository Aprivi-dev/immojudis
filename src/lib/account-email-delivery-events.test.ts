import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  revokeAlert: vi.fn(),
  revokeReminder: vi.fn(),
  revokeDigest: vi.fn(),
  revokeResults: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { rpc: mocks.rpc } }));
vi.mock("@/lib/email-alerts", () => ({
  revokeEmailAlertConsent: mocks.revokeAlert,
  revokeSaleReminderConsent: mocks.revokeReminder,
  revokeWeeklyDigestConsent: mocks.revokeDigest,
  revokeSaleResultsConsent: mocks.revokeResults,
}));

import {
  accountEmailActionOf,
  processAccountEmailDeliveryWebhook,
  revokeAllEmailConsents,
} from "@/lib/account-email-delivery-events";

const SECRET_BYTES = Buffer.from("account-emails-webhook-secret-for-tests");
const SECRET = `whsec_${SECRET_BYTES.toString("base64")}`;
const AGENT_FROM = "agent@information.immojudis.test";
const env = {
  RESEND_ACCOUNT_WEBHOOK_SECRET: SECRET,
  INFORMATION_AGENT_EMAIL_FROM: `Agent Immojudis <${AGENT_FROM}>`,
};

function signedRequest(event: unknown, overrides: { secret?: Buffer } = {}) {
  const payload = JSON.stringify(event);
  const id = "msg_test_1";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", overrides.secret ?? SECRET_BYTES)
    .update(`${id}.${timestamp}.${payload}`)
    .digest("base64");
  return new Request("https://immojudis.test/api/webhooks/resend/account-emails", {
    method: "POST",
    headers: {
      "svix-id": id,
      "svix-timestamp": timestamp,
      "svix-signature": `v1,${signature}`,
    },
    body: payload,
  });
}

function bounce(
  type: string,
  to = ["alice@example.test"],
  from = "Immojudis <alertes@immojudis.test>",
) {
  return {
    type: "email.bounced",
    created_at: "2026-10-31T10:00:00.000Z",
    data: {
      email_id: "e1",
      from,
      to,
      subject: "x",
      bounce: { type, subType: "General", message: "m" },
    },
  };
}

function complaint(to = ["alice@example.test"], from = "Immojudis <alertes@immojudis.test>") {
  return {
    type: "email.complained",
    created_at: "2026-10-31T10:00:00.000Z",
    data: { email_id: "e2", from, to, subject: "x" },
  };
}

describe("accountEmailActionOf", () => {
  it("retient un rebond définitif et une plainte, avec les adresses nues en minuscules", () => {
    expect(
      accountEmailActionOf(
        bounce("Permanent", ["Alice <ALICE@Example.test>", "alice@example.test"]),
        null,
      ),
    ).toEqual({ kind: "bounce_permanent", emails: ["alice@example.test"] });
    expect(accountEmailActionOf(complaint(["bob@example.test"]), null)).toEqual({
      kind: "complaint",
      emails: ["bob@example.test"],
    });
  });

  it("ignore un rebond passager ou indéterminé", () => {
    expect(accountEmailActionOf(bounce("Transient"), null)).toBeNull();
    expect(accountEmailActionOf(bounce("Undetermined"), null)).toBeNull();
    expect(accountEmailActionOf(bounce(""), null)).toBeNull();
  });

  it("ignore les autres évènements et les emails de l'agent d'information", () => {
    expect(
      accountEmailActionOf({ type: "email.delivered", data: { to: ["a@b.test"] } }, null),
    ).toBeNull();
    expect(
      accountEmailActionOf(bounce("Permanent", undefined, `Agent <${AGENT_FROM}>`), AGENT_FROM),
    ).toBeNull();
    expect(
      accountEmailActionOf(complaint(undefined, AGENT_FROM.toUpperCase()), AGENT_FROM),
    ).toBeNull();
  });

  it("ignore un évènement sans destinataire", () => {
    expect(accountEmailActionOf(complaint([]), null)).toBeNull();
  });
});

describe("processAccountEmailDeliveryWebhook", () => {
  const revoke = vi.fn();
  const findAccount = vi.fn();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    findAccount.mockResolvedValue("user-1");
    revoke.mockResolvedValue(undefined);
  });

  it("retire les consentements du compte après un rebond définitif signé", async () => {
    const result = await processAccountEmailDeliveryWebhook({
      request: signedRequest(bounce("Permanent")),
      env,
      findAccount,
      revoke,
    });

    expect(result).toEqual({ accepted: true, kind: "bounce_permanent", revokedAccounts: 1 });
    expect(findAccount).toHaveBeenCalledWith("alice@example.test");
    expect(revoke).toHaveBeenCalledWith("user-1");
  });

  it("traite une plainte comme un retrait de consentement", async () => {
    const result = await processAccountEmailDeliveryWebhook({
      request: signedRequest(complaint()),
      env,
      findAccount,
      revoke,
    });
    expect(result).toMatchObject({ accepted: true, kind: "complaint", revokedAccounts: 1 });
  });

  it("n'écrit rien pour un rebond passager, un email de l'agent ou une adresse inconnue", async () => {
    const transient = await processAccountEmailDeliveryWebhook({
      request: signedRequest(bounce("Transient")),
      env,
      findAccount,
      revoke,
    });
    const agent = await processAccountEmailDeliveryWebhook({
      request: signedRequest(complaint(undefined, AGENT_FROM)),
      env,
      findAccount,
      revoke,
    });
    expect(transient).toEqual({ accepted: true, ignored: true });
    expect(agent).toEqual({ accepted: true, ignored: true });
    expect(findAccount).not.toHaveBeenCalled();

    findAccount.mockResolvedValue(null);
    const unknown = await processAccountEmailDeliveryWebhook({
      request: signedRequest(complaint()),
      env,
      findAccount,
      revoke,
    });
    expect(unknown).toMatchObject({ accepted: true, revokedAccounts: 0 });
    expect(revoke).not.toHaveBeenCalled();
  });

  it("refuse une signature invalide avant toute lecture ou écriture", async () => {
    await expect(
      processAccountEmailDeliveryWebhook({
        request: signedRequest(complaint(), { secret: Buffer.from("autre-secret") }),
        env,
        findAccount,
        revoke,
      }),
    ).rejects.toMatchObject({ name: "InvalidAccountEmailWebhookSignatureError" });
    expect(findAccount).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  });

  it("refuse une requête sans en-têtes de signature", async () => {
    await expect(
      processAccountEmailDeliveryWebhook({
        request: new Request("https://immojudis.test/x", { method: "POST", body: "{}" }),
        env,
        findAccount,
        revoke,
      }),
    ).rejects.toMatchObject({ name: "InvalidAccountEmailWebhookSignatureError" });
  });

  it("échoue sans secret configuré (le fournisseur réessaiera)", async () => {
    await expect(
      processAccountEmailDeliveryWebhook({
        request: signedRequest(complaint()),
        env: {},
        findAccount,
        revoke,
      }),
    ).rejects.toThrow("Configuration");
  });

  it("refuse un corps trop volumineux", async () => {
    const request = new Request("https://immojudis.test/x", {
      method: "POST",
      headers: { "content-length": String(10 * 1024 * 1024) },
      body: "{}",
    });
    await expect(
      processAccountEmailDeliveryWebhook({ request, env, findAccount, revoke }),
    ).rejects.toMatchObject({ name: "AccountEmailWebhookPayloadTooLargeError" });
  });

  it("laisse remonter une panne de la base pour que l'évènement soit rejoué", async () => {
    revoke.mockRejectedValue(new Error("connection refused"));
    await expect(
      processAccountEmailDeliveryWebhook({
        request: signedRequest(complaint()),
        env,
        findAccount,
        revoke,
      }),
    ).rejects.toThrow("connection refused");
  });

  it("cherche le compte par la fonction SQL réservée au rôle de service", async () => {
    mocks.rpc.mockResolvedValue({ data: "user-9", error: null });
    mocks.revokeAlert.mockResolvedValue({});
    mocks.revokeReminder.mockResolvedValue({});
    mocks.revokeDigest.mockResolvedValue({});
    mocks.revokeResults.mockResolvedValue({});

    const result = await processAccountEmailDeliveryWebhook({
      request: signedRequest(complaint()),
      env,
    });

    expect(mocks.rpc).toHaveBeenCalledWith("user_id_for_email", { p_email: "alice@example.test" });
    expect(result).toMatchObject({ revokedAccounts: 1 });
    expect(mocks.revokeAlert).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-9" }));
  });
});

describe("revokeAllEmailConsents", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    for (const mock of [
      mocks.revokeAlert,
      mocks.revokeReminder,
      mocks.revokeDigest,
      mocks.revokeResults,
    ]) {
      mock.mockResolvedValue({});
    }
  });

  it("retire les quatre consentements email, l'alerte annulant aussi les envois en file", async () => {
    await revokeAllEmailConsents("user-1", new Date("2026-10-31T10:00:00.000Z"));

    for (const mock of [
      mocks.revokeAlert,
      mocks.revokeReminder,
      mocks.revokeDigest,
      mocks.revokeResults,
    ]) {
      expect(mock).toHaveBeenCalledWith({
        userId: "user-1",
        now: new Date("2026-10-31T10:00:00.000Z"),
      });
    }
  });

  it("tente les quatre retraits même si l'un échoue, puis signale l'échec", async () => {
    mocks.revokeReminder.mockRejectedValue(new Error("boom"));

    await expect(revokeAllEmailConsents("user-1")).rejects.toThrow("boom");

    expect(mocks.revokeAlert).toHaveBeenCalled();
    expect(mocks.revokeDigest).toHaveBeenCalled();
    expect(mocks.revokeResults).toHaveBeenCalled();
  });
});
