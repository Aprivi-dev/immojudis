// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  auth: { user: null as null | { id: string }, loading: false },
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => state.auth }));
// Le formulaire (chargé à la demande) est remplacé par un témoin : il a ses propres tests.
vi.mock("next/dynamic", () => ({
  default: () =>
    function FormStub(props: { criteria: Record<string, unknown> }) {
      return <div data-testid="sector-alert-form" data-criteria={JSON.stringify(props.criteria)} />;
    },
}));

import { DEPARTMENT_ALERT_LABEL, DepartmentAlertProposal } from "./DepartmentAlertProposal";

beforeEach(() => {
  state.auth = { user: null, loading: false };
});
afterEach(cleanup);

describe("DepartmentAlertProposal", () => {
  it("garde le bouton inactif tant qu'aucun département n'est choisi", () => {
    render(<DepartmentAlertProposal />);
    expect(screen.getByRole("heading", { name: DEPARTMENT_ALERT_LABEL })).toBeTruthy();
    const button = screen.getByRole("button", { name: DEPARTMENT_ALERT_LABEL });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("link", { name: DEPARTMENT_ALERT_LABEL })).toBeNull();
  });

  it("dit ce qui sera envoyé : rien par email sans la case dédiée", () => {
    render(<DepartmentAlertProposal />);
    const text = document.body.textContent ?? "";
    expect(text).toContain("Elle n’envoie aucun email par défaut");
    expect(text).toContain("que si vous cochez la case");
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("envoie un visiteur vers la connexion, motif « alerte », avec le département choisi", () => {
    render(<DepartmentAlertProposal />);
    fireEvent.change(screen.getByLabelText("Département"), { target: { value: "33" } });
    const link = screen.getByRole("link", { name: DEPARTMENT_ALERT_LABEL });
    expect(link.getAttribute("href")).toBe(
      "/login?redirect=%2Falertes%2Fcreer%3Fdepartment%3D33&mode=investor&reason=alerte",
    );
    expect(screen.queryByTestId("sector-alert-form")).toBeNull();
  });

  it("montre le formulaire de création à une personne connectée une fois le département choisi", () => {
    state.auth = { user: { id: "u1" }, loading: false };
    render(<DepartmentAlertProposal />);
    expect(screen.queryByTestId("sector-alert-form")).toBeNull();
    expect(screen.queryByRole("link", { name: DEPARTMENT_ALERT_LABEL })).toBeNull();
    fireEvent.change(screen.getByLabelText("Département"), { target: { value: "75" } });
    expect(screen.getByTestId("sector-alert-form").getAttribute("data-criteria")).toBe(
      '{"department":"75"}',
    );
  });

  it("garde le parcours visiteur pendant la vérification du compte", () => {
    state.auth = { user: { id: "u1" }, loading: true };
    render(<DepartmentAlertProposal />);
    fireEvent.change(screen.getByLabelText("Département"), { target: { value: "75" } });
    expect(screen.getByRole("link", { name: DEPARTMENT_ALERT_LABEL })).toBeTruthy();
    expect(screen.queryByTestId("sector-alert-form")).toBeNull();
  });
});
