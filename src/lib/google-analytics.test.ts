// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANALYTICS_CONSENT_MAX_AGE_MS,
  ANALYTICS_CONSENT_STORAGE_KEY,
  readAnalyticsConsent,
  setAnalyticsConsent,
} from "@/lib/analytics-consent";
import { setAudienceOptOut } from "@/lib/audience-opt-out";
import {
  enableGoogleAnalytics,
  GA_MEASUREMENT_ID,
  getGoogleAnalyticsState,
  revokeGoogleAnalytics,
  sanitizeAnalyticsUrl,
  trackGooglePageView,
} from "@/lib/google-analytics";

const ORIGIN = "http://localhost:3000";

beforeEach(() => {
  window.localStorage.clear();
  setAudienceOptOut(false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("analytics consent", () => {
  it("n'a aucun choix par défaut, puis mémorise l'accord ou le refus", () => {
    expect(readAnalyticsConsent()).toBeNull();
    setAnalyticsConsent("granted");
    expect(readAnalyticsConsent()).toBe("granted");
    setAnalyticsConsent("denied");
    expect(readAnalyticsConsent()).toBe("denied");
  });

  it("redemande le choix après 6 mois", () => {
    const given = new Date("2026-01-01T00:00:00.000Z");
    setAnalyticsConsent("granted", given);
    expect(readAnalyticsConsent(given.getTime() + ANALYTICS_CONSENT_MAX_AGE_MS - 1)).toBe(
      "granted",
    );
    expect(readAnalyticsConsent(given.getTime() + ANALYTICS_CONSENT_MAX_AGE_MS + 1)).toBeNull();
  });

  it("ignore une valeur illisible ou datée du futur", () => {
    window.localStorage.setItem(ANALYTICS_CONSENT_STORAGE_KEY, "granted");
    expect(readAnalyticsConsent()).toBeNull();
    window.localStorage.setItem(
      ANALYTICS_CONSENT_STORAGE_KEY,
      JSON.stringify({ choice: "granted", at: "2999-01-01T00:00:00.000Z" }),
    );
    expect(readAnalyticsConsent()).toBeNull();
  });

  it("fait primer l'opposition à la mesure d'audience sur l'accord", () => {
    expect(getGoogleAnalyticsState()).toBe("unset");
    setAnalyticsConsent("granted");
    expect(getGoogleAnalyticsState()).toBe("granted");
    setAudienceOptOut(true);
    expect(getGoogleAnalyticsState()).toBe("denied");
  });
});

describe("sanitizeAnalyticsUrl", () => {
  it("ne garde que les paramètres de campagne et retire le fragment", () => {
    expect(
      sanitizeAnalyticsUrl(
        `${ORIGIN}/sales?departement=75&utm_source=newsletter&code=abc&gclid=G1#access_token=x`,
        ORIGIN,
      ),
    ).toBe(`${ORIGIN}/sales?utm_source=newsletter&gclid=G1`);
    expect(sanitizeAnalyticsUrl(`${ORIGIN}/login?code=secret&next=/compte`, ORIGIN)).toBe(
      `${ORIGIN}/login`,
    );
  });

  it("masque les jetons des liens de partage", () => {
    expect(sanitizeAnalyticsUrl(`${ORIGIN}/reports/shared/abc123`, ORIGIN)).toBe(
      `${ORIGIN}/reports/shared/[jeton]`,
    );
    expect(sanitizeAnalyticsUrl(`${ORIGIN}/comparaisons/tok_456?x=1`, ORIGIN)).toBe(
      `${ORIGIN}/comparaisons/[jeton]`,
    );
    expect(sanitizeAnalyticsUrl(`${ORIGIN}/comparaisons`, ORIGIN)).toBe(`${ORIGIN}/comparaisons`);
  });

  it("réduit une adresse d'un autre site à son origine et refuse le reste", () => {
    expect(sanitizeAnalyticsUrl("https://www.google.com/search?q=encheres", ORIGIN)).toBe(
      "https://www.google.com/",
    );
    expect(sanitizeAnalyticsUrl("javascript:alert(1)", ORIGIN)).toBeNull();
  });
});

describe("gtag", () => {
  it("se configure sans page vue automatique, ni signaux Google, ni stockage publicitaire", () => {
    enableGoogleAnalytics();
    const calls = (window.dataLayer ?? []).map((entry) => Array.from(entry as ArrayLike<unknown>));
    expect(calls).toContainEqual([
      "consent",
      "default",
      {
        ad_storage: "denied",
        ad_user_data: "denied",
        ad_personalization: "denied",
        analytics_storage: "granted",
      },
    ]);
    const config = calls.find((call) => call[0] === "config");
    expect(config?.[1]).toBe(GA_MEASUREMENT_ID);
    expect(config?.[2]).toMatchObject({
      send_page_view: false,
      cookie_update: false,
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
    });
    // 13 mois au plus (plafond CNIL).
    expect((config?.[2] as { cookie_expires: number }).cookie_expires).toBeLessThanOrEqual(
      13 * 31 * 24 * 60 * 60,
    );

    window.dataLayer = [];
    trackGooglePageView(`${ORIGIN}/sales`, null);
    const sent = window.dataLayer.map((entry) => Array.from(entry as ArrayLike<unknown>));
    expect(sent[0]).toEqual(["set", expect.objectContaining({ page_location: `${ORIGIN}/sales` })]);
    expect(sent[1]).toEqual([
      "event",
      "page_view",
      expect.objectContaining({ page_location: `${ORIGIN}/sales`, page_referrer: "" }),
    ]);
  });

  it("coupe les envois et efface les cookies Google Analytics au retrait de l'accord", () => {
    enableGoogleAnalytics();
    document.cookie = "_ga=GA1.1.123; path=/";
    document.cookie = "_ga_FVY2EYX5MP=GS1.1.456; path=/";
    document.cookie = "immojudis_pref=1; path=/";

    revokeGoogleAnalytics();

    expect((window as unknown as Record<string, unknown>)[`ga-disable-${GA_MEASUREMENT_ID}`]).toBe(
      true,
    );
    expect(document.cookie).not.toMatch(/_ga/);
    expect(document.cookie).toContain("immojudis_pref=1");

    enableGoogleAnalytics();
    expect((window as unknown as Record<string, unknown>)[`ga-disable-${GA_MEASUREMENT_ID}`]).toBe(
      false,
    );
  });
});
