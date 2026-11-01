import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { rpc: vi.fn() } }));

import { captureFailure, deliveryLogArgsOf } from "@/lib/email-delivery-log";

const base = {
  email_id: "re_FACTICE_FACTICE",
  from: "Immojudis <alertes@immojudis.test>",
  to: ["Alice@Example.test"],
  subject: "Objet",
};

describe("deliveryLogArgsOf", () => {
  it.each(["email.delivered", "email.delivery_delayed", "email.failed"])(
    "retient %s avec l'identifiant Resend et l'instant de l'évènement",
    (type) => {
      expect(
        deliveryLogArgsOf({ type, created_at: "2026-11-01T10:00:00.000Z", data: base }),
      ).toMatchObject({
        p_resend_email_id: "re_FACTICE_FACTICE",
        p_event: type,
        p_occurred_at: "2026-11-01T10:00:00.000Z",
        p_to: "Alice@Example.test",
      });
    },
  );

  it("garde le type d'un rebond, et un court code (jamais le texte) pour un échec", () => {
    expect(
      deliveryLogArgsOf({
        type: "email.bounced",
        data: { ...base, bounce: { type: "Permanent", message: "alice@example.test inconnue" } },
      }),
    ).toMatchObject({ p_bounce_type: "Permanent" });
    const failed = deliveryLogArgsOf({
      type: "email.failed",
      data: { ...base, failed: { reason: "Reached daily quota! (alice@example.test)" } },
    });
    expect(failed?.p_error_code).toBe("reached_daily_quota_alice_example_test");
    expect(failed?.p_error_code).toMatch(/^[a-z0-9_]{1,60}$/);
  });

  it("n'abonne ni ne lit les ouvertures, les clics et les autres évènements", () => {
    for (const type of ["email.opened", "email.clicked", "email.sent", "email.received", "x"]) {
      expect(deliveryLogArgsOf({ type, data: base }), type).toBeNull();
    }
  });

  it("ignore un évènement sans identifiant d'email", () => {
    expect(
      deliveryLogArgsOf({ type: "email.delivered", data: { ...base, email_id: "" } }),
    ).toBeNull();
    expect(deliveryLogArgsOf({ type: "email.delivered" })).toBeNull();
  });
});

describe("captureFailure", () => {
  it("rend l'erreur au lieu de la lever", async () => {
    const error = new Error("panne");
    expect(await captureFailure(async () => Promise.reject(error))).toEqual({ error });
    expect(await captureFailure(async () => undefined)).toBeNull();
  });
});

const ROOT = process.cwd();
function walk(relative: string): string[] {
  return readdirSync(path.join(ROOT, relative)).flatMap((entry) => {
    const child = path.join(relative, entry);
    if (statSync(path.join(ROOT, child)).isDirectory()) return walk(child);
    return /\.tsx?$/.test(entry) && !/\.(?:test|spec)\./.test(entry) ? [child] : [];
  });
}

describe("la suppression durable ne dépend jamais du journal des envois", () => {
  // Retrait des consentements, bounce_status des contacts, liste d'opposition : tout se lit dans l'évènement
  // reçu, jamais dans email_send_log. Le journal est une mémoire, pas une décision.
  const codeOf = (file: string) =>
    readFileSync(path.join(ROOT, file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
  const readers = walk("src").filter((file) => /email_send_log/.test(codeOf(file)));

  it("n'est lu que par l'historique d'administration et par les droits des personnes", () => {
    const allowed = [
      path.join("src", "integrations", "supabase", "types.ts"),
      path.join("src", "lib", "email-delivery-log.ts"),
      path.join("src", "lib", "send-tracked-email.ts"),
      path.join("src", "lib", "privacy-requests.ts"),
      path.join("src", "lib", "information-agent-professional-rights.ts"),
      path.join("src", "lib", "admin-emails", "history.ts"),
    ];
    for (const file of readers) expect(allowed, file).toContain(file);
  });

  it("n'apparaît ni dans les webhooks, ni dans les retraits de consentement, ni dans le registre des contacts", () => {
    const decisionFiles = [
      "src/lib/account-email-delivery-events.ts",
      "src/lib/information-agent-inbound.ts",
      "src/lib/information-agent-inbound/delivery-events.ts",
      "src/lib/information-agent-inbound/case-updates.ts",
      "src/lib/email-alerts.ts",
      "src/lib/sale-reminders.ts",
      "src/lib/weekly-digest.ts",
      "src/lib/sale-results.ts",
      "src/app/api/webhooks/resend/account-emails/route.ts",
      "src/app/api/webhooks/resend/information-agent/route.ts",
    ];
    for (const file of decisionFiles) {
      expect(codeOf(file), file).not.toMatch(/email_send_log|record_email_send/);
    }
  });

  it("ne se lit pas dans les migrations qui retirent les consentements ou posent le rebond", () => {
    const migrations = readdirSync(path.join(ROOT, "supabase/migrations"))
      .filter((file) => file.endsWith(".sql") && file < "20261110210000")
      .filter((file) =>
        /email_send_log/.test(readFileSync(path.join(ROOT, "supabase/migrations", file), "utf8")),
      );
    expect(migrations).toEqual([]);
  });
});
