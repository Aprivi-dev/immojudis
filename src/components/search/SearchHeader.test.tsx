// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CsvExportButton, SaveSearchButton } from "./SearchHeader";

vi.mock("next/navigation", () => ({ usePathname: () => "/sales" }));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: null, profile: null, loading: false }),
}));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { auth: { signOut: vi.fn() } } }));

afterEach(cleanup);

describe("SaveSearchButton", () => {
  it("n'affiche ni cadenas ni mention de l'offre Analyse : la première alerte est gratuite", () => {
    const onClick = vi.fn();
    const { container } = render(<SaveSearchButton saving={false} onClick={onClick} />);
    const button = screen.getByRole("button", { name: "Créer une alerte" });
    expect(button.textContent).toBe("Créer une alerte");
    expect(container.querySelector(".lucide-lock-keyhole")).toBeNull();
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("garde un nom accessible en version compacte", () => {
    render(<SaveSearchButton compact saving={false} onClick={() => undefined} />);
    expect(screen.getByRole("button", { name: "Créer une alerte" })).toBeTruthy();
  });
});

describe("SaveSearchButton avec compte", () => {
  it("propose la fréquence quotidienne par défaut et réserve l'hebdomadaire à l'offre Analyse", () => {
    const onClick = vi.fn();
    render(<SaveSearchButton signedIn saving={false} onClick={onClick} />);
    fireEvent.click(screen.getByRole("button", { name: "Créer une alerte" }));
    expect(screen.getByText(/un seul email récapitulatif/)).toBeTruthy();
    const weekly = screen.getByRole("radio", { name: /Hebdomadaire/ }) as HTMLInputElement;
    expect(weekly.disabled).toBe(true);
    expect((screen.getByRole("radio", { name: "Quotidienne" }) as HTMLInputElement).checked).toBe(
      true,
    );
    fireEvent.click(screen.getByRole("button", { name: "Créer l’alerte" }));
    expect(onClick).toHaveBeenCalledWith({ frequency: "daily" });
  });

  it("permet l'hebdomadaire avec l'offre Analyse", () => {
    const onClick = vi.fn();
    render(<SaveSearchButton signedIn weeklyAllowed saving={false} onClick={onClick} />);
    fireEvent.click(screen.getByRole("button", { name: "Créer une alerte" }));
    fireEvent.click(screen.getByRole("radio", { name: /Hebdomadaire/ }));
    fireEvent.click(screen.getByRole("button", { name: "Créer l’alerte" }));
    expect(onClick).toHaveBeenCalledWith({ frequency: "weekly" });
  });
});

describe("CsvExportButton", () => {
  it("reste cliquable pour un visiteur afin de le rediriger vers la connexion", () => {
    const onClick = vi.fn();
    render(<CsvExportButton exporting={false} locked onClick={onClick} />);
    fireEvent.click(screen.getByRole("button", { name: "Exporter en CSV" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
