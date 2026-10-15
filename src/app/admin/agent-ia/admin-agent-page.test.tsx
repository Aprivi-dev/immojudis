// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentPanelsLoading } from "./admin-agent-page";

vi.mock("@/components/admin/AdminShell", () => ({
  AdminPanel: ({ children }: { children: ReactNode }) => <section>{children}</section>,
  AdminShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));

vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: null }) }));

afterEach(cleanup);

describe("AdminAgentPage", () => {
  it("annonce le chargement des panneaux de l'agent d'information", () => {
    render(<AgentPanelsLoading />);

    expect(screen.getByRole("status").textContent).toBe(
      "Chargement des panneaux de l’agent d’information…",
    );
  });
});
