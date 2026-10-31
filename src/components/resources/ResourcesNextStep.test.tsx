// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: null, loading: false }) }));

import { ResourcesNextStep } from "./ResourcesNextStep";

afterEach(cleanup);

describe("ResourcesNextStep", () => {
  it("garde « Explorer les ventes » et propose d'être prévenu des ventes de son département", async () => {
    render(<ResourcesNextStep />);
    expect(screen.getByRole("link", { name: /Explorer les ventes/ }).getAttribute("href")).toBe(
      "/sales",
    );
    // Chargée à la demande (un seul fichier partagé par les pages qui la montrent).
    expect(
      await screen.findByRole(
        "heading",
        { name: "Être prévenu des ventes de mon département" },
        { timeout: 10_000 },
      ),
    ).toBeTruthy();
    // Aucun email par défaut : la case n'apparaît qu'après la création, et décochée.
    expect(document.body.textContent).toContain("L’email récapitulatif est facultatif");
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});
