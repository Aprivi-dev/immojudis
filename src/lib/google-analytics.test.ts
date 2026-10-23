// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANALYTICS_CONSENT_MAX_AGE_MS,
  ANALYTICS_CONSENT_STORAGE_KEY,
  ANALYTICS_CONSENT_TEXT_VERSION,
  readAnalyticsConsent,
  setAnalyticsConsent,
} from "@/lib/analytics-consent";
import { setAudienceOptOut } from "@/lib/audience-opt-out";
import {
  enableGoogleAnalytics,
  GA_MEASUREMENT_ID,
  revokeGoogleAnalytics,
  sanitizeAnalyticsUrl,
  suspendGoogleAnalytics,
  trackGooglePageView,
} from "@/lib/google-analytics";
import { getGoogleAnalyticsState } from "@/lib/google-analytics-state";

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

  it("efface l'accord à l'opposition : le retrait de l'opposition redemande le choix", () => {
    setAnalyticsConsent("granted");
    expect(getGoogleAnalyticsState()).toBe("granted");

    setAudienceOptOut(true);
    expect(getGoogleAnalyticsState()).toBe("denied");
    expect(window.localStorage.getItem(ANALYTICS_CONSENT_STORAGE_KEY)).toBeNull();

    setAudienceOptOut(false);
    expect(readAnalyticsConsent()).toBeNull();
    expect(getGoogleAnalyticsState()).toBe("unset");
  });

  it("efface aussi un accord gardé en mémoire quand le stockage est inaccessible", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("stockage bloqué");
    });
    setAnalyticsConsent("granted");
    expect(getGoogleAnalyticsState()).toBe("granted");

    setAudienceOptOut(true);
    setAudienceOptOut(false);
    expect(getGoogleAnalyticsState()).toBe("unset");
  });

  it("mémorise la version du texte avec le choix et redemande si elle change", () => {
    setAnalyticsConsent("granted");
    expect(JSON.parse(window.localStorage.getItem(ANALYTICS_CONSENT_STORAGE_KEY)!)).toMatchObject({
      choice: "granted",
      version: ANALYTICS_CONSENT_TEXT_VERSION,
    });

    const at = new Date().toISOString();
    window.localStorage.setItem(
      ANALYTICS_CONSENT_STORAGE_KEY,
      JSON.stringify({ choice: "granted", at, version: ANALYTICS_CONSENT_TEXT_VERSION + 1 }),
    );
    expect(readAnalyticsConsent()).toBeNull();
    expect(getGoogleAnalyticsState()).toBe("unset");

    // Un choix enregistré avant l'introduction de la version vaut pour la version 1.
    window.localStorage.setItem(
      ANALYTICS_CONSENT_STORAGE_KEY,
      JSON.stringify({ choice: "denied", at }),
    );
    expect(readAnalyticsConsent()).toBe("denied");
  });
});

describe("sanitizeAnalyticsUrl", () => {
  it("ne garde que les paramètres utm et retire le fragment", () => {
    expect(
      sanitizeAnalyticsUrl(
        `${ORIGIN}/sales?departement=75&utm_source=newsletter&code=abc#access_token=x`,
        ORIGIN,
      ),
    ).toBe(`${ORIGIN}/sales?utm_source=newsletter`);
    expect(sanitizeAnalyticsUrl(`${ORIGIN}/login?code=secret&next=/compte`, ORIGIN)).toBe(
      `${ORIGIN}/login`,
    );
  });

  it("retire les identifiants publicitaires et les paramètres utm contenant une arobase", () => {
    expect(
      sanitizeAnalyticsUrl(
        `${ORIGIN}/sales?gclid=G1&gbraid=B1&wbraid=W1&utm_source=lettre&utm_content=jean%40exemple.fr&utm_term=a@b`,
        ORIGIN,
      ),
    ).toBe(`${ORIGIN}/sales?utm_source=lettre`);
  });

  it("masque l'identifiant du lien personnel de dépôt d'informations", () => {
    expect(
      sanitizeAnalyticsUrl(`${ORIGIN}/contribuer/22222222-2222-4222-8222-222222222222?x=1`, ORIGIN),
    ).toBe(`${ORIGIN}/contribuer/[jeton]`);
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
    window.history.pushState({}, "", "/sales?q=secret&gclid=G1&utm_source=lettre#access_token=x");
    enableGoogleAnalytics();
    window.history.pushState({}, "", "/");
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
    // L'adresse nettoyée part avec `config` lui-même, jamais l'adresse brute du navigateur.
    expect(config?.[2]).toMatchObject({
      page_location: `${ORIGIN}/sales?utm_source=lettre`,
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

  it("suspend les envois sans effacer les cookies, puis les reprend", () => {
    enableGoogleAnalytics();
    document.cookie = "_ga=GA1.1.123; path=/";
    suspendGoogleAnalytics();
    const flag = () =>
      (window as unknown as Record<string, unknown>)[`ga-disable-${GA_MEASUREMENT_ID}`];
    expect(flag()).toBe(true);
    expect(document.cookie).toContain("_ga=");
    enableGoogleAnalytics();
    expect(flag()).toBe(false);
    document.cookie = "_ga=; Max-Age=0; path=/";
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
