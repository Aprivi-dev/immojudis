import { describe, expect, it } from "vitest";
import { buildEnvironmentReadiness } from "@/lib/admin-readiness";

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
});
