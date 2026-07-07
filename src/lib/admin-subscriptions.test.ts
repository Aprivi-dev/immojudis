import { describe, expect, it } from "vitest";
import {
  adminSubscriptionGrantInputSchema,
  manualSubscriptionPayload,
} from "@/lib/admin-subscriptions";

describe("admin subscriptions", () => {
  it("normalizes manual grant input and preserves existing Stripe identifiers", () => {
    const input = adminSubscriptionGrantInputSchema.parse({
      target: "investisseur@example.test",
      planCode: "investisseur",
      status: "trialing",
      currentPeriodEnd: "2026-08-01T12:30:00.000Z",
      note: "Accès pilote",
    });

    const payload = manualSubscriptionPayload({
      input,
      user: { id: "b8d4f60a-9e58-4a4c-83d7-30874062a395", email: "investisseur@example.test" },
      grantedBy: "3f1a1d80-8163-46b8-84de-fcfef5875652",
      existing: {
        stripe_customer_id: "cus_existing",
        stripe_subscription_id: "sub_existing",
        metadata: { previous: true },
      },
    });

    expect(payload).toMatchObject({
      user_id: "b8d4f60a-9e58-4a4c-83d7-30874062a395",
      plan_code: "investisseur",
      status: "trialing",
      stripe_customer_id: "cus_existing",
      stripe_subscription_id: "sub_existing",
    });
    expect(payload.current_period_end).toBe("2026-08-01T12:30:00.000Z");
    expect(payload.metadata).toMatchObject({
      previous: true,
      manual_grant: {
        source: "admin",
        granted_by: "3f1a1d80-8163-46b8-84de-fcfef5875652",
        target_email: "investisseur@example.test",
        plan_code: "investisseur",
        status: "trialing",
        note: "Accès pilote",
      },
    });
  });
});
