// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  idle: [] as Array<() => void>,
  pathname: "/",
  analyticsModuleLoads: 0,
}));

vi.mock("@/lib/when-idle", () => ({
  whenIdle: (callback: () => void) => {
    mocks.idle.push(callback);
    return () => {
      mocks.idle = mocks.idle.filter((pending) => pending !== callback);
    };
  },
}));

vi.mock("@/hooks/use-public-pathname", () => ({
  usePublicPathname: () => mocks.pathname,
}));

vi.mock("next/script", () => ({
  default: (props: { src?: string }) => <script data-testid="gtag-script" data-src={props.src} />,
}));

// Le compteur s'incrémente à l'évaluation du module : il compte les imports réellement faits.
vi.mock("./GoogleAnalytics", async (importOriginal) => {
  mocks.analyticsModuleLoads += 1;
  return importOriginal();
});

import { setAnalyticsConsent } from "@/lib/analytics-consent";
import { setAudienceOptOut } from "@/lib/audience-opt-out";
import { enableGoogleAnalytics, GA_MEASUREMENT_ID } from "@/lib/google-analytics";
import { ANALYTICS_EXCLUDED_PATHS } from "@/lib/google-analytics-state";
import { DeferredGoogleAnalytics } from "./DeferredGoogleAnalytics";

async function becomeIdle() {
  await act(async () => mocks.idle.splice(0).forEach((callback) => callback()));
}

function pageViews(): unknown[][] {
  return (window.dataLayer ?? [])
    .map((entry) => Array.from(entry as ArrayLike<unknown>))
    .filter((call) => call[0] === "event" && call[1] === "page_view");
}

const disableFlag = () =>
  (window as unknown as Record<string, unknown>)[`ga-disable-${GA_MEASUREMENT_ID}`];

beforeEach(() => {
  mocks.idle = [];
  mocks.pathname = "/";
  window.localStorage.clear();
  window.dataLayer = [];
  setAudienceOptOut(false);
});

afterEach(cleanup);

describe("DeferredGoogleAnalytics : module de la balise", () => {
  // Ce test doit rester le premier : l'import du module n'est évalué qu'une fois par fichier.
  it("n'importe pas le module de la balise tant qu'il n'y a pas d'accord", async () => {
    const { unmount } = render(<DeferredGoogleAnalytics />);
    await becomeIdle();
    expect(await screen.findByTestId("cookie-consent-banner")).toBeTruthy();
    unmount();

    setAnalyticsConsent("denied");
    render(<DeferredGoogleAnalytics />);
    await becomeIdle();
    expect(screen.queryByTestId("cookie-consent-banner")).toBeNull();
    expect(screen.queryByTestId("gtag-script")).toBeNull();
    expect(mocks.analyticsModuleLoads).toBe(0);
  });

  it("charge la balise après l'accord seulement", async () => {
    setAnalyticsConsent("granted");
    render(<DeferredGoogleAnalytics />);
    await becomeIdle();
    expect(await screen.findByTestId("gtag-script")).toBeTruthy();
    expect(screen.queryByTestId("cookie-consent-banner")).toBeNull();
    expect(mocks.analyticsModuleLoads).toBe(1);
  });

  it("efface les cookies Google Analytics restants quand il n'y a pas (ou plus) d'accord", async () => {
    document.cookie = "_ga=GA1.1.123; path=/";
    document.cookie = "_ga_FVY2EYX5MP=GS1.1.456; path=/";
    setAnalyticsConsent("denied");
    render(<DeferredGoogleAnalytics />);
    await becomeIdle();
    await waitFor(() => expect(document.cookie).not.toMatch(/_ga/));
  });
});

describe("DeferredGoogleAnalytics : pages exclues de la mesure", () => {
  const sensitivePaths = ANALYTICS_EXCLUDED_PATHS.flatMap((path) => [path, `${path}/abc-123`]);

  it("couvre les pages sensibles prévues", () => {
    expect([...ANALYTICS_EXCLUDED_PATHS].sort()).toEqual([
      "/admin",
      "/compte",
      "/contribuer",
      "/login",
      "/mes-droits",
    ]);
  });

  it.each(sensitivePaths)("ne monte ni la balise ni le bandeau sur %s", async (path) => {
    mocks.pathname = path;

    // Accord donné : pas de balise, pas de page vue.
    setAnalyticsConsent("granted");
    const granted = render(<DeferredGoogleAnalytics />);
    await becomeIdle();
    expect(screen.queryByTestId("gtag-script")).toBeNull();
    expect(pageViews()).toHaveLength(0);
    granted.unmount();

    // Aucun choix : pas de bandeau.
    window.localStorage.clear();
    render(<DeferredGoogleAnalytics />);
    await becomeIdle();
    expect(screen.queryByTestId("cookie-consent-banner")).toBeNull();
  });

  it("ne confond pas un chemin voisin avec une page exclue", async () => {
    mocks.pathname = "/compte-rendu";
    render(<DeferredGoogleAnalytics />);
    await becomeIdle();
    expect(await screen.findByTestId("cookie-consent-banner")).toBeTruthy();
  });

  it("suspend les envois d'une balise déjà chargée pendant la visite d'une page exclue", async () => {
    setAnalyticsConsent("granted");
    mocks.pathname = "/";
    const view = render(<DeferredGoogleAnalytics />);
    await becomeIdle();
    await screen.findByTestId("gtag-script");
    enableGoogleAnalytics();
    expect(disableFlag()).toBe(false);

    window.history.pushState({}, "", "/compte");
    mocks.pathname = "/compte";
    view.rerender(<DeferredGoogleAnalytics />);
    expect(screen.queryByTestId("gtag-script")).toBeNull();
    await waitFor(() => expect(disableFlag()).toBe(true));

    window.history.pushState({}, "", "/");
    mocks.pathname = "/";
    view.rerender(<DeferredGoogleAnalytics />);
    expect(await screen.findByTestId("gtag-script")).toBeTruthy();
  });
});
