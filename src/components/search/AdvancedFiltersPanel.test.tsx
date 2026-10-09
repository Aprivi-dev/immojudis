// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptySearchDraft } from "./search-page-state";
import { MobileFilterDrawer } from "./AdvancedFiltersPanel";

vi.mock("./DateRangeFields", () => ({ DateRangeFields: () => null }));
vi.mock("@/lib/router-compat", () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));

afterEach(cleanup);

function renderDrawer() {
  return render(
    <MobileFilterDrawer
      draft={emptySearchDraft()}
      setDraft={vi.fn()}
      activeFiltersCount={0}
      onClose={vi.fn()}
      onReset={vi.fn()}
    />,
  );
}

describe("filtres sur mobile", () => {
  it("affiche de vrais libellés au-dessus des champs", () => {
    renderDrawer();
    for (const label of [
      "Minimum (€)",
      "Maximum (€)",
      "Chambres minimum",
      "Salles de bain minimum",
      "Ville",
      "Tribunal",
      "Département",
    ]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it("n'affiche « Mise à prix » qu'une seule fois", () => {
    renderDrawer();
    expect(screen.getAllByText("Mise à prix")).toHaveLength(1);
  });
});
