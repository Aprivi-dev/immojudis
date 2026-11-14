// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminPagination } from "./AdminPagination";

afterEach(cleanup);

function renderBar(props: { offset: unknown; total: unknown; shown: number; limit?: unknown }) {
  return render(
    <AdminPagination
      label="demandes"
      offset={props.offset as number}
      limit={(props.limit ?? 50) as number}
      // Réponse mal formée simulée : le type promet un nombre, le serveur peut ne rien envoyer.
      total={props.total as number}
      shown={props.shown}
      onOffsetChange={vi.fn()}
    />,
  );
}

describe("AdminPagination", () => {
  it("compte les pages quand le total est connu", () => {
    renderBar({ offset: 50, total: 120, shown: 50 });
    expect(screen.getByRole("status").textContent).toBe("51–100 sur 120 · page 2 sur 3");
  });

  it("n'affiche ni « NaN » ni « undefined » quand le total manque", () => {
    const { container } = renderBar({ offset: 0, total: undefined, shown: 0 });
    expect(container.textContent).not.toMatch(/NaN|undefined/);
  });

  it("n'affiche ni « NaN » ni « undefined » quand offset, limit et total manquent", () => {
    const { container } = renderBar({
      offset: undefined,
      limit: undefined,
      total: undefined,
      shown: 0,
    });
    expect(container.textContent).not.toMatch(/NaN|undefined/);
  });

  it("sans total, s'en tient aux lignes reçues sur une page suivante", () => {
    renderBar({ offset: 50, total: undefined, shown: 10 });
    expect(screen.getByRole("status").textContent).toBe("51–60 sur 60 · page 2 sur 2");
    expect(screen.getByRole("button", { name: "Suivant — demandes" })).toHaveProperty(
      "disabled",
      true,
    );
  });
});
