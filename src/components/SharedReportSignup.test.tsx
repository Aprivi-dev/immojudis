// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("@/lib/product-events", () => ({ trackProductEvent: mocks.track }));

import { SharedReportSignup } from "./SharedReportSignup";

afterEach(() => {
  cleanup();
  mocks.track.mockClear();
});

describe("SharedReportSignup", () => {
  it("propose l'inscription avec le motif dédié du rapport partagé", () => {
    render(<SharedReportSignup state="open" />);
    expect(
      screen.getByRole("link", { name: "Créer mon compte gratuit" }).getAttribute("href"),
    ).toBe("/login?mode=investor&reason=rapport");
    expect(document.body.textContent).not.toMatch(/gagn|garanti|rentab/i);
  });

  it("mesure l'ouverture de la page par son état seul, sans jeton ni identifiant", () => {
    render(<SharedReportSignup state="unavailable" />);
    expect(mocks.track.mock.calls).toEqual([["shared_report_viewed", { state: "unavailable" }]]);
  });
});
