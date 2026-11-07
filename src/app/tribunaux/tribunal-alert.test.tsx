// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ user: null as null | { id: string }, loading: false }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => auth }));

import { TRIBUNAL_ALERT_TITLE, TribunalAlert } from "./tribunal-alert";

const TRIBUNAL = { searchName: "TJ Bobigny", longName: "Tribunal judiciaire de Bobigny" };
const DEPARTMENT = { code: "93", where: "en Seine-Saint-Denis" };

const target = () =>
  decodeURIComponent(
    screen.getByRole("link", { name: "Créer l’alerte" }).getAttribute("href") ?? "",
  );

beforeEach(() => {
  auth.user = null;
  auth.loading = false;
});
afterEach(cleanup);

describe("TribunalAlert", () => {
  it("emmène une personne connectée vers la confirmation de l'alerte choisie, sans détour par la connexion", () => {
    auth.user = { id: "user-1" };
    render(<TribunalAlert tribunal={TRIBUNAL} department={DEPARTMENT} />);
    expect(target()).toBe("/alertes/creer?tribunal=TJ+Bobigny");
    fireEvent.click(screen.getByRole("radio", { name: /Tout le département/ }));
    expect(target()).toBe("/alertes/creer?department=93");
    expect(screen.getByText(/Vous confirmez l’alerte à l’étape suivante/)).toBeTruthy();
  });

  it("fait passer un visiteur par la connexion (motif « alerte »), qui ramène à la confirmation", () => {
    render(<TribunalAlert tribunal={TRIBUNAL} department={DEPARTMENT} />);
    expect(target()).toBe(
      "/login?redirect=/alertes/creer?tribunal=TJ+Bobigny&mode=investor&reason=alerte",
    );
    expect(screen.getByText(/Compte gratuit, sans carte bancaire/)).toBeTruthy();
  });

  it("nomme la section par son titre et groupe le choix sous une légende", () => {
    render(<TribunalAlert tribunal={TRIBUNAL} department={DEPARTMENT} />);
    expect(screen.getByRole("region", { name: TRIBUNAL_ALERT_TITLE })).toBeTruthy();
    expect(screen.getByRole("group", { name: "L’alerte porte sur :" })).toBeTruthy();
    expect(screen.getAllByRole("radio")).toHaveLength(2);
  });

  it("propose le département seul, sans choix, pour un tribunal sans nom lisible", () => {
    render(<TribunalAlert tribunal={null} department={DEPARTMENT} />);
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.getByRole("region", { name: "Être prévenu des nouvelles ventes" })).toBeTruthy();
    expect(screen.getByText(/tous tribunaux confondus/)).toBeTruthy();
    expect(target()).toContain("department=93");
  });

  it("propose le tribunal seul, sans choix, quand le département n'est pas connu", () => {
    render(<TribunalAlert tribunal={TRIBUNAL} department={null} />);
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.getByText(/pour le tribunal judiciaire de Bobigny/)).toBeTruthy();
    expect(target()).toContain("tribunal=TJ+Bobigny");
  });

  it("ne montre rien sans tribunal nommé ni département", () => {
    const { container } = render(<TribunalAlert tribunal={null} department={null} />);
    expect(container.innerHTML).toBe("");
  });
});
