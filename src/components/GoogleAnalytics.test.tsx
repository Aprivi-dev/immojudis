// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  idle: [] as Array<() => void>,
  pathname: "/sales",
  scripts: [] as Array<{ src?: string }>,
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
  default: (props: { src?: string }) => {
    mocks.scripts.push(props);
    return <script data-testid="gtag-script" data-src={props.src} />;
  },
}));

import { setAnalyticsConsent } from "@/lib/analytics-consent";
import { setAudienceOptOut } from "@/lib/audience-opt-out";
import { GA_SCRIPT_URL } from "@/lib/google-analytics";
import { CookieConsentBanner } from "./CookieConsentBanner";
import { DeferredGoogleAnalytics } from "./DeferredGoogleAnalytics";
import { GoogleAnalytics } from "./GoogleAnalytics";

async function becomeIdle() {
  await act(async () => mocks.idle.splice(0).forEach((callback) => callback()));
}

function pageViews(): unknown[][] {
  return (window.dataLayer ?? [])
    .map((entry) => Array.from(entry as ArrayLike<unknown>))
    .filter((call) => call[0] === "event" && call[1] === "page_view");
}

beforeEach(() => {
  mocks.idle = [];
  mocks.pathname = "/sales";
  mocks.scripts = [];
  window.localStorage.clear();
  window.dataLayer = [];
  setAudienceOptOut(false);
});

afterEach(cleanup);

describe("GoogleAnalytics", () => {
  it("ne charge rien sans accord", async () => {
    render(<GoogleAnalytics />);
    await becomeIdle();
    expect(screen.queryByTestId("gtag-script")).toBeNull();
    expect(pageViews()).toHaveLength(0);
  });

  it("ne charge rien après un refus ni avec l'opposition à la mesure d'audience", async () => {
    setAnalyticsConsent("denied");
    const { unmount } = render(<GoogleAnalytics />);
    await becomeIdle();
    expect(screen.queryByTestId("gtag-script")).toBeNull();
    unmount();

    setAnalyticsConsent("granted");
    setAudienceOptOut(true);
    render(<GoogleAnalytics />);
    await becomeIdle();
    expect(screen.queryByTestId("gtag-script")).toBeNull();
  });

  it("charge la balise après l'accord et compte chaque page", async () => {
    setAnalyticsConsent("granted");
    const view = render(<GoogleAnalytics />);

    expect(screen.getByTestId("gtag-script").getAttribute("data-src")).toBe(GA_SCRIPT_URL);
    // La page vue attend à son tour l'inactivité (titre de la page posé).
    expect(pageViews()).toHaveLength(0);
    await becomeIdle();
    expect(pageViews()).toHaveLength(1);

    mocks.pathname = "/tribunaux";
    window.history.pushState({}, "", "/tribunaux?utm_source=lettre&q=secret");
    view.rerender(<GoogleAnalytics />);
    await becomeIdle();
    const views = pageViews();
    expect(views).toHaveLength(2);
    expect(views[1]![2]).toMatchObject({
      page_location: `${window.location.origin}/tribunaux?utm_source=lettre`,
    });
  });

  it("retire la balise dès le retrait de l'accord", async () => {
    setAnalyticsConsent("granted");
    render(<GoogleAnalytics />);
    await becomeIdle();
    expect(screen.getByTestId("gtag-script")).toBeTruthy();

    act(() => setAnalyticsConsent("denied"));
    expect(screen.queryByTestId("gtag-script")).toBeNull();
  });
});

describe("DeferredGoogleAnalytics", () => {
  it("ne charge la balise ni le bandeau avant l'inactivité du navigateur", async () => {
    render(<DeferredGoogleAnalytics />);
    expect(screen.queryByTestId("cookie-consent-banner")).toBeNull();
    await becomeIdle();
    expect(await screen.findByTestId("cookie-consent-banner")).toBeTruthy();
    expect(screen.queryByTestId("gtag-script")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Accepter" }));
    expect(await screen.findByTestId("gtag-script")).toBeTruthy();
    expect(screen.queryByTestId("cookie-consent-banner")).toBeNull();
  });
});

describe("CookieConsentBanner", () => {
  it("demande le choix tant qu'il n'y en a pas, avec refus et accord au même niveau", async () => {
    render(<CookieConsentBanner />);

    const refuse = screen.getByRole("button", { name: "Refuser" });
    const accept = screen.getByRole("button", { name: "Accepter" });
    expect(refuse.className).toBe(accept.className);
    expect(screen.getByRole("link", { name: "En savoir plus" }).getAttribute("href")).toBe(
      "/privacy#cookies",
    );

    fireEvent.click(refuse);
    expect(screen.queryByTestId("cookie-consent-banner")).toBeNull();
  });

  it("enregistre l'accord et ne revient plus", async () => {
    const { unmount } = render(<CookieConsentBanner />);
    await becomeIdle();
    fireEvent.click(screen.getByRole("button", { name: "Accepter" }));
    expect(screen.queryByTestId("cookie-consent-banner")).toBeNull();
    unmount();

    render(<CookieConsentBanner />);
    await becomeIdle();
    expect(screen.queryByTestId("cookie-consent-banner")).toBeNull();
  });

  it("ne s'affiche pas quand l'opposition à la mesure d'audience est active", async () => {
    setAudienceOptOut(true);
    render(<CookieConsentBanner />);
    await becomeIdle();
    expect(screen.queryByTestId("cookie-consent-banner")).toBeNull();
  });
});
