// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const track = vi.hoisted(() => vi.fn());
vi.mock("@vercel/analytics", () => ({ track }));

import { AUDIENCE_OPT_OUT_STORAGE_KEY, setAudienceOptOut } from "./audience-opt-out";
import {
  PRODUCT_EVENT_NAMES,
  sanitizeProductEventProperties,
  trackProductEvent,
} from "./product-events";

beforeEach(() => {
  track.mockReset();
  window.localStorage.clear();
  setAudienceOptOut(false);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("product events", () => {
  it("does nothing in the test environment", () => {
    trackProductEvent("signup_submitted", { entry: "direct" });
    expect(track).not.toHaveBeenCalled();
  });

  it("does nothing on the server", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubGlobal("window", undefined);
    trackProductEvent("offers_viewed");
    expect(track).not.toHaveBeenCalled();
  });

  describe("in the browser", () => {
    beforeEach(() => {
      vi.stubEnv("NODE_ENV", "production");
    });

    it("sends every event without property by its name only", () => {
      trackProductEvent("signup_confirmed");
      trackProductEvent("favorite_added");
      trackProductEvent("sample_report_viewed");
      trackProductEvent("offers_viewed");
      trackProductEvent("checkout_started");
      trackProductEvent("opening_notification_requested");
      trackProductEvent("fees_simulator_used");
      trackProductEvent("home_example_used");
      trackProductEvent("pepite_filter_used");
      expect(track.mock.calls).toEqual([
        ["signup_confirmed"],
        ["favorite_added"],
        ["sample_report_viewed"],
        ["offers_viewed"],
        ["checkout_started"],
        ["opening_notification_requested"],
        ["fees_simulator_used"],
        ["home_example_used"],
        ["pepite_filter_used"],
      ]);
    });

    it("sends the origin of a sign-up from the closed list, and nothing else", () => {
      trackProductEvent("signup_submitted", { entry: "exemple" });
      trackProductEvent("signup_submitted", { entry: "direct" });
      // @ts-expect-error Only a login reason or `direct` is an origin, never a free address.
      trackProductEvent("signup_submitted", { entry: "/sales?q=Bordeaux" });
      expect(track.mock.calls).toEqual([
        ["signup_submitted", { entry: "exemple" }],
        ["signup_submitted", { entry: "direct" }],
        ["signup_submitted"],
      ]);
    });

    it("sends the access level of the pepite block, from the closed list only", () => {
      trackProductEvent("pepite_block_viewed", { access: "locked" });
      trackProductEvent("pepite_block_viewed", { access: "detail" });
      // @ts-expect-error `criteria` is the payload name, not an event value.
      trackProductEvent("pepite_block_viewed", { access: "criteria" });
      expect(track.mock.calls).toEqual([
        ["pepite_block_viewed", { access: "locked" }],
        ["pepite_block_viewed", { access: "detail" }],
        ["pepite_block_viewed"],
      ]);
    });

    it("tells apart the alerts created from the pepite filter", () => {
      trackProductEvent("alert_created", { email_consent: false, pepite_only: true });
      expect(track.mock.calls).toEqual([
        ["alert_created", { email_consent: false, pepite_only: true }],
      ]);
    });

    it("sends the typed properties of alert_created and checkout_returned", () => {
      trackProductEvent("alert_created", { email_consent: true });
      trackProductEvent("alert_created", { email_consent: false });
      trackProductEvent("checkout_returned", { status: "success" });
      trackProductEvent("checkout_returned", { status: "cancelled" });
      expect(track.mock.calls).toEqual([
        ["alert_created", { email_consent: true }],
        ["alert_created", { email_consent: false }],
        ["checkout_returned", { status: "success" }],
        ["checkout_returned", { status: "cancelled" }],
      ]);
    });

    it("drops any property outside the closed list, whatever the caller passes", () => {
      const unsafe = {
        email_consent: true,
        email: "personne@example.test",
        user_id: "user-1",
        sale_id: "sale-1",
        query: "Bordeaux",
      };
      // The types forbid extra properties on literals; this checks the runtime guard as well.
      trackProductEvent("alert_created", unsafe);
      // @ts-expect-error A property on an event that declares none.
      trackProductEvent("favorite_added", { sale_id: "sale-1" });
      expect(track.mock.calls).toEqual([
        ["alert_created", { email_consent: true }],
        ["favorite_added"],
      ]);
    });

    it("drops a property whose value is outside its category", () => {
      // @ts-expect-error Free text is not an allowed status.
      trackProductEvent("checkout_returned", { status: "cs_test_123" });
      // @ts-expect-error The consent is a boolean, never a string.
      trackProductEvent("alert_created", { email_consent: "oui" });
      expect(track.mock.calls).toEqual([["checkout_returned"], ["alert_created"]]);
    });

    it("sends nothing once the visitor has opposed the audience measurement", () => {
      setAudienceOptOut(true);
      trackProductEvent("signup_submitted", { entry: "direct" });
      trackProductEvent("alert_created", { email_consent: true });
      expect(track).not.toHaveBeenCalled();

      setAudienceOptOut(false);
      trackProductEvent("signup_submitted", { entry: "direct" });
      expect(track.mock.calls).toEqual([["signup_submitted", { entry: "direct" }]]);
    });

    it("honours an opposition stored by an earlier visit", () => {
      window.localStorage.setItem(AUDIENCE_OPT_OUT_STORAGE_KEY, "1");
      trackProductEvent("offers_viewed");
      expect(track).not.toHaveBeenCalled();
    });

    it("keeps an event sent before the Vercel script is injected, for the script to send", () => {
      const page = window as unknown as { va?: unknown; vaq?: unknown[] };
      page.va = undefined;
      page.vaq = undefined;

      trackProductEvent("offers_viewed");
      expect(typeof page.va).toBe("function");

      // Same queue as the one `@vercel/analytics` creates itself: the script drains `vaq`.
      (page.va as (...params: unknown[]) => void)("event", { name: "offers_viewed" });
      expect(page.vaq).toEqual([["event", { name: "offers_viewed" }]]);

      // A queue that already exists (injected script, or the package's own) is left alone.
      const existing = vi.fn();
      page.va = existing;
      trackProductEvent("sample_report_viewed");
      expect(page.va).toBe(existing);
      page.va = undefined;
      page.vaq = undefined;
    });

    it("never lets an analytics failure reach the caller", () => {
      track.mockImplementation(() => {
        throw new Error("blocked");
      });
      expect(() => trackProductEvent("offers_viewed")).not.toThrow();
    });
  });

  it("keeps the list of event names closed and anonymous", () => {
    expect([...PRODUCT_EVENT_NAMES]).toEqual([
      "signup_submitted",
      "signup_confirmed",
      "alert_created",
      "favorite_added",
      "sample_report_viewed",
      "offers_viewed",
      "checkout_started",
      "checkout_returned",
      "opening_notification_requested",
      "fees_simulator_used",
      "home_example_used",
      "pepite_block_viewed",
      "pepite_filter_used",
    ]);
    expect(sanitizeProductEventProperties("alert_created", null)).toBeUndefined();
  });
});
