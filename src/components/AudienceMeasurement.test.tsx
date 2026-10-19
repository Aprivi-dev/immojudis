// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  analytics: vi.fn(),
  speedInsights: vi.fn(),
  idle: [] as Array<() => void>,
}));

vi.mock("@/lib/when-idle", () => ({
  whenIdle: (callback: () => void) => {
    mocks.idle.push(callback);
    return () => {
      mocks.idle = mocks.idle.filter((pending) => pending !== callback);
    };
  },
}));

vi.mock("@vercel/analytics/next", () => ({
  Analytics: (props: unknown) => {
    mocks.analytics(props);
    return <div data-testid="analytics" />;
  },
}));
vi.mock("@vercel/speed-insights/next", () => ({
  SpeedInsights: (props: unknown) => {
    mocks.speedInsights(props);
    return <div data-testid="speed-insights" />;
  },
}));

import { setAudienceOptOut } from "@/lib/audience-opt-out";
import { AudienceMeasurement } from "./AudienceMeasurement";

/** Rend le composant puis simule le passage du navigateur à l'inactivité. */
async function renderMeasured() {
  const view = render(<AudienceMeasurement />);
  await act(async () => mocks.idle.splice(0).forEach((callback) => callback()));
  return view;
}

beforeEach(() => {
  mocks.idle = [];
  window.localStorage.clear();
  setAudienceOptOut(false);
  vi.clearAllMocks();
});

afterEach(cleanup);

describe("AudienceMeasurement", () => {
  it("charge Vercel Analytics et Speed Insights tant que le visiteur ne s'y oppose pas", async () => {
    await renderMeasured();
    expect(await screen.findByTestId("analytics")).toBeTruthy();
    expect(await screen.findByTestId("speed-insights")).toBeTruthy();
  });

  it("n'en charge aucun avant l'inactivité du navigateur", async () => {
    render(<AudienceMeasurement />);
    expect(mocks.idle).toHaveLength(1);
    expect(screen.queryByTestId("analytics")).toBeNull();
    expect(screen.queryByTestId("speed-insights")).toBeNull();
    expect(mocks.analytics).not.toHaveBeenCalled();
    await act(async () => mocks.idle.splice(0).forEach((callback) => callback()));
    expect(await screen.findByTestId("analytics")).toBeTruthy();
  });

  it("ne rend ni l'un ni l'autre quand l'opposition est déjà mémorisée", async () => {
    setAudienceOptOut(true);
    await renderMeasured();
    expect(screen.queryByTestId("analytics")).toBeNull();
    expect(screen.queryByTestId("speed-insights")).toBeNull();
    expect(mocks.analytics).not.toHaveBeenCalled();
    expect(mocks.speedInsights).not.toHaveBeenCalled();
  });

  it("les retire dès que l'opposition est activée pendant la visite", async () => {
    await renderMeasured();
    expect(await screen.findByTestId("analytics")).toBeTruthy();

    act(() => setAudienceOptOut(true));
    expect(screen.queryByTestId("analytics")).toBeNull();
    expect(screen.queryByTestId("speed-insights")).toBeNull();

    act(() => setAudienceOptOut(false));
    expect(await screen.findByTestId("analytics")).toBeTruthy();
  });

  it("annule les envois déjà armés une fois l'opposition activée", async () => {
    await renderMeasured();
    await waitFor(() => expect(mocks.analytics).toHaveBeenCalled());
    const analytics = mocks.analytics.mock.calls[0]![0] as {
      beforeSend: (event: unknown) => unknown;
    };
    const speedInsights = mocks.speedInsights.mock.calls[0]![0] as {
      beforeSend: (event: unknown) => unknown;
    };
    const pageview = { type: "pageview", url: "https://immojudis.test/" };

    expect(analytics.beforeSend(pageview)).toBe(pageview);
    expect(speedInsights.beforeSend(pageview)).toBe(pageview);

    act(() => setAudienceOptOut(true));
    expect(analytics.beforeSend(pageview)).toBeNull();
    expect(speedInsights.beforeSend(pageview)).toBeNull();
  });
});
