// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AUDIENCE_OPT_OUT_STORAGE_KEY,
  isAudienceOptedOut,
  setAudienceOptOut,
} from "@/lib/audience-opt-out";
import { AudienceOptOutSwitch } from "./AudienceOptOutSwitch";

beforeEach(() => {
  window.localStorage.clear();
  setAudienceOptOut(false);
});

afterEach(cleanup);

function toggle() {
  return screen.getByRole("switch", {
    name: "Je m’oppose à la mesure d’audience sur ce navigateur",
  }) as HTMLInputElement;
}

describe("AudienceOptOutSwitch", () => {
  it("indique que la mesure est active par défaut", () => {
    render(<AudienceOptOutSwitch />);
    expect(toggle().checked).toBe(false);
    expect(screen.getByRole("status").textContent).toContain("Mesure d’audience active");
  });

  it("mémorise l'opposition dans le navigateur puis la retire", () => {
    render(<AudienceOptOutSwitch />);

    fireEvent.click(toggle());
    expect(toggle().checked).toBe(true);
    expect(isAudienceOptedOut()).toBe(true);
    expect(window.localStorage.getItem(AUDIENCE_OPT_OUT_STORAGE_KEY)).toBe("1");
    expect(screen.getByRole("status").textContent).toContain("Opposition enregistrée");

    fireEvent.click(toggle());
    expect(toggle().checked).toBe(false);
    expect(isAudienceOptedOut()).toBe(false);
  });

  it("affiche l'opposition mémorisée lors d'une visite précédente", () => {
    window.localStorage.setItem(AUDIENCE_OPT_OUT_STORAGE_KEY, "1");
    render(<AudienceOptOutSwitch />);
    expect(toggle().checked).toBe(true);
  });
});
