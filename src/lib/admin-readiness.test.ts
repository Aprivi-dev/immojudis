import { describe, expect, it } from "vitest";
import { aiDescriptionItem, buildEnvironmentReadiness } from "@/lib/admin-readiness";

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
  });

  it("marks launch readiness ready when commercial and pipeline envs are configured", () => {
    const items = buildEnvironmentReadiness({
      NEXT_PUBLIC_APP_URL: "https://immojudis.example",
      STRIPE_SECRET_KEY: "stripe-secret-test",
      STRIPE_ANALYSE_PRICE_ID: "price_analyse",
      STRIPE_INVESTISSEUR_PRICE_ID: "price_investisseur",
      STRIPE_WEBHOOK_SECRET: "whsec_test",
      RESEND_API_KEY: "re_test",
      ALERT_EMAIL_FROM: "ImmoJudis <alertes@immojudis.fr>",
      CRON_SECRET: "cron-secret",
      GITHUB_SCROLL_TOKEN: "ghp_test",
      REPLICATE_API_TOKEN: "replicate-token-test",
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
});
