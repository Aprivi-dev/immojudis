import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildEnvironmentReadiness,
  getAdminOperationalReadiness,
  operationalAlertSummary,
  operationalHealthItem,
} from "@/lib/admin-readiness";

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuthContext: vi.fn().mockResolvedValue({ isAdmin: true }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("operational alert summary", () => {
  it("sends French labels with each alert, so the browser never loads the label table", () => {
    const summary = operationalAlertSummary({
      key: ["information_agent", "unrouted", "pending"].join("."),
      category: "cron",
      severity: "warning",
      status: "resolved",
      deliveryStatus: "failed",
      lastSeenAt: "2026-11-14T07:45:00.000Z",
    });
    expect(summary).toMatchObject({
      label: "Messages reçus sans dossier, en attente de traitement",
      place: { href: "/admin/agent-ia?onglet=reponses", label: "Agent IA › Réponses" },
      severityLabel: "Avertissement",
      stateLabel: "Refermée",
      notificationLabel: "En échec",
    });
  });
});

describe("admin readiness", () => {
  it("marks commercial launch blockers when Stripe envs are missing", () => {
    const items = buildEnvironmentReadiness({
      NEXT_PUBLIC_APP_URL: "https://immojudis.example",
      CRON_SECRET: "cron-secret",
    });

    expect(items.find((item) => item.key === "billing.checkout.analyse")).toMatchObject({
      status: "blocked",
      detail: expect.stringContaining("Price récurrent"),
      action: expect.stringContaining("STRIPE_ANALYSIS_PRICE_ID"),
    });
    expect(items.find((item) => item.key === "billing.webhook")).toMatchObject({
      status: "blocked",
    });
    expect(items.find((item) => item.key === "cron.smart_alerts")).toMatchObject({
      status: "ready",
      detail: "20 routes cron sont protégées par CRON_SECRET.",
    });
    expect(items.find((item) => item.key === "email.alert_delivery")).toMatchObject({
      status: "blocked",
    });
    expect(items.find((item) => item.key === "access.manual_grants")).toMatchObject({
      status: "ready",
    });
    expect(items.find((item) => item.key === "pipeline.dispatch")).toMatchObject({
      status: "blocked",
      detail: expect.not.stringContaining("en file"),
    });
    // The AI description backfill was removed: no readiness check for it any more.
    expect(items.find((item) => item.key === "pipeline.llm_backfill")).toBeUndefined();
    expect(items.find((item) => item.key === "operations.external_alerts")).toMatchObject({
      status: "blocked",
    });
  });

  it("does not treat whitespace-only secrets as configured", () => {
    const items = buildEnvironmentReadiness({
      NEXT_PUBLIC_APP_URL: "https://immojudis.example",
      STRIPE_SECRET_KEY: "   ",
      STRIPE_WEBHOOK_SECRET: "\t",
      CRON_SECRET: "\n",
    });

    expect(items.find((item) => item.key === "billing.checkout.analyse")).toMatchObject({
      status: "blocked",
    });
    expect(items.find((item) => item.key === "billing.webhook")).toMatchObject({
      status: "blocked",
    });
    expect(items.find((item) => item.key === "cron.smart_alerts")).toMatchObject({
      status: "blocked",
    });
  });

  it("marks launch readiness ready when commercial and pipeline envs are configured", () => {
    const items = buildEnvironmentReadiness({
      NEXT_PUBLIC_APP_URL: "https://immojudis.example",
      STRIPE_SECRET_KEY: "stripe-secret-test",
      STRIPE_ANALYSIS_PRICE_ID: "price_1AnalysisTest",
      STRIPE_WEBHOOK_SECRET: "whsec_test",
      RESEND_API_KEY: "re_test",
      ALERT_EMAIL_FROM: "Immojudis <alertes@immojudis.fr>",
      CRON_SECRET: "cron-secret",
      GITHUB_SCROLL_TOKEN: "ghp_test",
      REPLICATE_API_TOKEN: "replicate-token-test",
      NEXT_PUBLIC_LEGAL_ENTITY_NAME: "Immojudis SAS",
      NEXT_PUBLIC_LEGAL_ENTITY_FORM: "SAS",
      NEXT_PUBLIC_LEGAL_ENTITY_ADDRESS: "1 rue de Paris, 75001 Paris",
      NEXT_PUBLIC_LEGAL_REGISTRATION: "RCS Paris 000 000 000",
      NEXT_PUBLIC_LEGAL_PUBLICATION_DIRECTOR: "Direction Immojudis",
      NEXT_PUBLIC_LEGAL_CONTACT_EMAIL: "contact@immojudis.fr",
      NEXT_PUBLIC_LEGAL_CONTACT_PHONE: "+33 1 00 00 00 00",
      NEXT_PUBLIC_LEGAL_MEDIATOR_NAME: "Médiateur de la consommation",
      NEXT_PUBLIC_LEGAL_MEDIATOR_ADDRESS: "1 rue de la Médiation, 75001 Paris",
      NEXT_PUBLIC_LEGAL_MEDIATOR_WEBSITE: "https://mediateur.example",
    });

    expect(items.every((item) => item.status === "ready")).toBe(true);
  });

  it("no longer audits the AI summary coverage, which the pipeline stopped producing", async () => {
    for (const name of ["SUPABASE_DB_URL", "POSTGRES_URL_NON_POOLING", "POSTGRES_URL"]) {
      vi.stubEnv(name, "");
    }

    const readiness = await getAdminOperationalReadiness("admin-jwt");

    expect(readiness).not.toHaveProperty("aiDescriptions");
    expect(readiness.items.map((item) => item.key)).not.toContain(
      "pipeline.ai_description_coverage",
    );
    expect(readiness.items.map((item) => item.key)).toEqual(
      expect.arrayContaining(["database.migrations", "operations.health"]),
    );
  });

  it("turns a failed external delivery into an operator action", () => {
    expect(
      operationalHealthItem({
        status: "blocked",
        schedulerActive: true,
        schedulerSchedule: "*/15 * * * *",
        sloTargetPercent: 99.5,
        sloWindowDays: 30,
        successfulRunCount: 98,
        failedRunCount: 2,
        totalRunCount: 100,
        successRatePercent: 98,
        openAlertCount: 1,
        criticalOpenAlertCount: 0,
        pendingDeliveryCount: 0,
        failedDeliveryCount: 1,
        lastHealthRunAt: "2026-07-27T10:00:00.000Z",
        lastHealthRunFresh: true,
        alerts: [],
        detail: "1 notification externe est en échec.",
      }),
    ).toMatchObject({
      key: "operations.health",
      status: "blocked",
      action: expect.stringContaining("canal externe"),
    });
  });

  it("surfaces an unmet health SLO without inventing an operational incident", () => {
    expect(
      operationalHealthItem({
        status: "warning",
        schedulerActive: true,
        schedulerSchedule: "*/15 * * * *",
        sloTargetPercent: 99.5,
        sloWindowDays: 30,
        successfulRunCount: 98,
        failedRunCount: 2,
        totalRunCount: 100,
        successRatePercent: 98,
        openAlertCount: 0,
        criticalOpenAlertCount: 0,
        pendingDeliveryCount: 0,
        failedDeliveryCount: 0,
        lastHealthRunAt: "2026-07-29T14:15:00.000Z",
        lastHealthRunFresh: true,
        alerts: [],
        detail: "Le contrôle de santé atteint 98,000 % sur 30 jours, sous le SLO de 99,5 %.",
      }),
    ).toMatchObject({
      key: "operations.health",
      status: "warning",
      action: expect.stringContaining("exécutions en échec"),
    });
  });
});
