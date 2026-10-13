// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  analytics: vi.fn(),
  speedInsights: vi.fn(),
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

beforeEach(() => {
  window.localStorage.clear();
  setAudienceOptOut(false);
  vi.clearAllMocks();
});

afterEach(cleanup);

describe("AudienceMeasurement", () => {
  it("charge Vercel Analytics et Speed Insights tant que le visiteur ne s'y oppose pas", () => {
    render(<AudienceMeasurement />);
    expect(screen.getByTestId("analytics")).toBeTruthy();
    expect(screen.getByTestId("speed-insights")).toBeTruthy();
  });

  it("ne rend ni l'un ni l'autre quand l'opposition est déjà mémorisée", () => {
    setAudienceOptOut(true);
    render(<AudienceMeasurement />);
    expect(screen.queryByTestId("analytics")).toBeNull();
    expect(screen.queryByTestId("speed-insights")).toBeNull();
    expect(mocks.analytics).not.toHaveBeenCalled();
    expect(mocks.speedInsights).not.toHaveBeenCalled();
  });

  it("les retire dès que l'opposition est activée pendant la visite", () => {
    render(<AudienceMeasurement />);
    expect(screen.getByTestId("analytics")).toBeTruthy();

    act(() => setAudienceOptOut(true));
    expect(screen.queryByTestId("analytics")).toBeNull();
    expect(screen.queryByTestId("speed-insights")).toBeNull();

    act(() => setAudienceOptOut(false));
    expect(screen.getByTestId("analytics")).toBeTruthy();
  });

  it("annule les envois déjà armés une fois l'opposition activée", () => {
    render(<AudienceMeasurement />);
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
