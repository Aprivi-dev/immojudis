import { describe, expect, it } from "vitest";
import {
  aiDescriptionItem,
  buildEnvironmentReadiness,
  operationalHealthItem,
} from "@/lib/admin-readiness";

describe("admin readiness", () => {
  it("marks commercial launch blockers when Stripe envs are missing", () => {
    const items = buildEnvironmentReadiness({
      NEXT_PUBLIC_APP_URL: "https://immojudis.example",
      CRON_SECRET: "cron-secret",
    });

    expect(items.find((item) => item.key === "billing.checkout.analyse")).toMatchObject({
      status: "blocked",
    });
    expect(items.find((item) => item.key === "billing.webhook")).toMatchObject({
      status: "blocked",
    });
    expect(items.find((item) => item.key === "cron.smart_alerts")).toMatchObject({
      status: "ready",
    });
    expect(items.find((item) => item.key === "email.alert_delivery")).toMatchObject({
      status: "blocked",
    });
    expect(items.find((item) => item.key === "access.manual_grants")).toMatchObject({
      status: "ready",
    });
    expect(items.find((item) => item.key === "pipeline.dispatch")).toMatchObject({
      status: "warning",
    });
    expect(items.find((item) => item.key === "pipeline.llm_backfill")).toMatchObject({
      status: "warning",
    });
    expect(items.find((item) => item.key === "operations.external_alerts")).toMatchObject({
      status: "blocked",
    });
  });

  it("marks launch readiness ready when commercial and pipeline envs are configured", () => {
    const items = buildEnvironmentReadiness({
      NEXT_PUBLIC_APP_URL: "https://immojudis.example",
      STRIPE_SECRET_KEY: "stripe-secret-test",
      STRIPE_WEBHOOK_SECRET: "whsec_test",
      RESEND_API_KEY: "re_test",
      ALERT_EMAIL_FROM: "ImmoJudis <alertes@immojudis.fr>",
      CRON_SECRET: "cron-secret",
      GITHUB_SCROLL_TOKEN: "ghp_test",
      REPLICATE_API_TOKEN: "replicate-token-test",
      NEXT_PUBLIC_LEGAL_ENTITY_NAME: "ImmoJudis SAS",
      NEXT_PUBLIC_LEGAL_ENTITY_FORM: "SAS",
      NEXT_PUBLIC_LEGAL_ENTITY_ADDRESS: "1 rue de Paris, 75001 Paris",
      NEXT_PUBLIC_LEGAL_REGISTRATION: "RCS Paris 000 000 000",
      NEXT_PUBLIC_LEGAL_PUBLICATION_DIRECTOR: "Direction ImmoJudis",
      NEXT_PUBLIC_LEGAL_CONTACT_EMAIL: "contact@immojudis.fr",
      NEXT_PUBLIC_LEGAL_CONTACT_PHONE: "+33 1 00 00 00 00",
      NEXT_PUBLIC_LEGAL_MEDIATOR_NAME: "Médiateur de la consommation",
      NEXT_PUBLIC_LEGAL_MEDIATOR_ADDRESS: "1 rue de la Médiation, 75001 Paris",
      NEXT_PUBLIC_LEGAL_MEDIATOR_WEBSITE: "https://mediateur.example",
    });

    expect(items.every((item) => item.status === "ready")).toBe(true);
  });

  it("blocks launch readiness when active sales miss current AI descriptions", () => {
    expect(
      aiDescriptionItem({
        status: "blocked",
        promptVersion: "auction_llm_v6_display",
        activeUpcomingCount: 149,
        coveredCurrentCount: 145,
        missingCurrentCount: 4,
        missingSourceCount: 1,
        recentFailureCount: 2,
        detail:
          "4/149 annonces n'ont pas de synthèse IA courante ; 1 sans description source exploitable ; 2 en quarantaine après échec récent.",
      }),
    ).toMatchObject({
      key: "pipeline.ai_description_coverage",
      area: "pipeline",
      status: "blocked",
      action: expect.stringContaining("backfill IA"),
    });
  });

  it("does not require an action when every active sale has a current AI description", () => {
    expect(
      aiDescriptionItem({
        status: "ready",
        promptVersion: "auction_llm_v6_display",
        activeUpcomingCount: 149,
        coveredCurrentCount: 149,
        missingCurrentCount: 0,
        missingSourceCount: 0,
        recentFailureCount: 0,
        detail: "149/149 annonces actives ou à venir ont une synthèse IA.",
      }),
    ).toMatchObject({
      status: "ready",
      action: null,
    });
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
        alerts: [],
        detail: "Le contrôle de santé atteint 98.000 % sur 30 jours, sous le SLO de 99.5 %.",
      }),
    ).toMatchObject({
      key: "operations.health",
      status: "warning",
      action: expect.stringContaining("exécutions en échec"),
    });
  });
});
