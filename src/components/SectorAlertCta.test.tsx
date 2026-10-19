// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  auth: { user: null as null | { id: string }, loading: false },
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => state.auth }));
// Le formulaire (chargé à la demande) est remplacé par un témoin : il a ses propres tests.
vi.mock("next/dynamic", () => ({
  default: () =>
    function FormStub(props: { actionLabel?: string; criteria: Record<string, unknown> }) {
      return (
        <div data-testid="sector-alert-form" data-criteria={JSON.stringify(props.criteria)}>
          {props.actionLabel}
        </div>
      );
    },
}));

import { SectorAlertCta, SECTOR_ALERT_LABEL } from "./SectorAlertCta";

beforeEach(() => {
  state.auth = { user: null, loading: false };
});
afterEach(cleanup);

describe("SectorAlertCta", () => {
  it("envoie un visiteur vers la connexion, motif « alerte », avec ses critères à retrouver", () => {
    render(<SectorAlertCta criteria={{ department: "33" }} intro="Le texte d'introduction." />);
    const link = screen.getByRole("link", { name: SECTOR_ALERT_LABEL });
    expect(SECTOR_ALERT_LABEL).toBe("Recevoir les nouvelles ventes de ce secteur");
    expect(link.getAttribute("href")).toBe(
      "/login?redirect=%2Falertes%2Fcreer%3Fdepartment%3D33&mode=investor&reason=alerte",
    );
    expect(screen.getByText("Le texte d'introduction.")).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByTestId("sector-alert-form")).toBeNull();
  });

  it("garde le lien de connexion pendant la vérification du compte", () => {
    state.auth = { user: { id: "u1" }, loading: true };
    render(<SectorAlertCta criteria={{ department: "33" }} />);
    expect(screen.getByRole("link", { name: SECTOR_ALERT_LABEL })).toBeTruthy();
    expect(screen.queryByTestId("sector-alert-form")).toBeNull();
  });

  it("montre le formulaire de création à une personne connectée, avec le bouton du secteur", () => {
    state.auth = { user: { id: "u1" }, loading: false };
    render(<SectorAlertCta criteria={{ department: "33" }} />);
    const form = screen.getByTestId("sector-alert-form");
    expect(form.textContent).toBe(SECTOR_ALERT_LABEL);
    expect(form.getAttribute("data-criteria")).toBe('{"department":"33"}');
    expect(screen.queryByRole("link", { name: SECTOR_ALERT_LABEL })).toBeNull();
  });
});
