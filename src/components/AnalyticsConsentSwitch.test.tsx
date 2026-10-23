// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readAnalyticsConsent, setAnalyticsConsent } from "@/lib/analytics-consent";
import { setAudienceOptOut } from "@/lib/audience-opt-out";
import { AnalyticsConsentSwitch } from "./AnalyticsConsentSwitch";

beforeEach(() => {
  window.localStorage.clear();
  setAudienceOptOut(false);
});

afterEach(cleanup);

const googleSwitch = () => screen.getByRole("switch", { name: /cookies de Google Analytics/ });

describe("AnalyticsConsentSwitch", () => {
  it("est décoché sans accord et explique que rien n'est chargé", () => {
    render(<AnalyticsConsentSwitch />);
    expect((googleSwitch() as HTMLInputElement).checked).toBe(false);
    expect(screen.getByRole("status").textContent).toMatch(/Aucun accord/);
  });

  it("enregistre l'accord à la coche, puis le retire à la décoche", () => {
    render(<AnalyticsConsentSwitch />);

    fireEvent.click(googleSwitch());
    expect(readAnalyticsConsent()).toBe("granted");
    expect((googleSwitch() as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("status").textContent).toMatch(/Accord enregistré/);

    fireEvent.click(googleSwitch());
    expect(readAnalyticsConsent()).toBe("denied");
    expect((googleSwitch() as HTMLInputElement).checked).toBe(false);
  });

  it("reflète un choix fait ailleurs (bandeau, autre onglet)", () => {
    render(<AnalyticsConsentSwitch />);
    act(() => setAnalyticsConsent("granted"));
    expect((googleSwitch() as HTMLInputElement).checked).toBe(true);
  });

  it("est désactivé tant que l'opposition à la mesure est active, et revient décoché après son retrait", () => {
    setAnalyticsConsent("granted");
    render(<AnalyticsConsentSwitch />);
    expect((googleSwitch() as HTMLInputElement).checked).toBe(true);

    act(() => setAudienceOptOut(true));
    expect((googleSwitch() as HTMLInputElement).disabled).toBe(true);
    expect((googleSwitch() as HTMLInputElement).checked).toBe(false);
    expect(screen.getByRole("status").textContent).toMatch(/Je m’oppose à la mesure d’audience/);

    // Le retrait de l'opposition ne rétablit pas l'ancien accord : un nouveau choix est attendu.
    act(() => setAudienceOptOut(false));
    expect((googleSwitch() as HTMLInputElement).disabled).toBe(false);
    expect((googleSwitch() as HTMLInputElement).checked).toBe(false);
    expect(readAnalyticsConsent()).toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/Aucun accord/);
  });
});
