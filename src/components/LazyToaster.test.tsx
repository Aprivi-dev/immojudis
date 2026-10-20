// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loaded = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/components/AppToaster", () => {
  loaded.count += 1;
  return { AppToaster: () => <div data-testid="toaster" /> };
});

import { resetToastForTests, toast } from "@/lib/toast";
import { LazyToaster } from "./LazyToaster";

beforeEach(() => {
  resetToastForTests();
});

afterEach(() => {
  cleanup();
});

describe("LazyToaster", () => {
  it("ne charge pas l'affichage des notifications tant qu'aucune n'est émise", async () => {
    render(<LazyToaster />);
    await act(async () => {});

    expect(screen.queryByTestId("toaster")).toBeNull();
    expect(loaded.count).toBe(0);
  });

  it("charge et monte l'affichage à la première notification", async () => {
    render(<LazyToaster />);

    await act(async () => {
      toast.success("Bonjour");
    });

    expect(await screen.findByTestId("toaster")).toBeTruthy();
    expect(loaded.count).toBe(1);
  });

  it("monte l'affichage pour une notification émise avant le rendu du fournisseur", async () => {
    toast.error("Trop tôt");

    render(<LazyToaster />);

    expect(await screen.findByTestId("toaster")).toBeTruthy();
  });

  it("monte dès le premier rendu une région vivante vide (role=status, aria-live=polite)", () => {
    render(<LazyToaster />);
    const announcer = screen.getByTestId("toast-announcer");
    expect(announcer.getAttribute("role")).toBe("status");
    expect(announcer.getAttribute("aria-live")).toBe("polite");
    expect(announcer.className).toContain("sr-only");
    expect(announcer.textContent).toBe("");
  });

  it("relaie dans cette région le texte de la première notification", async () => {
    render(<LazyToaster />);
    await act(async () => {
      toast.success("Statut enregistré");
    });
    expect(screen.getByTestId("toast-announcer").textContent).toBe("Statut enregistré");
  });

  it("relaie aussi une notification émise avant le rendu du fournisseur", async () => {
    toast.error("Trop tôt");
    render(<LazyToaster />);
    await act(async () => {});
    expect(screen.getByTestId("toast-announcer").textContent).toBe("Trop tôt");
  });

  it("relit un texte identique émis deux fois de suite", async () => {
    render(<LazyToaster />);
    const announcer = screen.getByTestId("toast-announcer");
    await act(async () => {
      toast.error("Échec");
    });
    const first = announcer.textContent;
    await act(async () => {
      toast.error("Échec");
    });
    expect(announcer.textContent).not.toBe(first);
    expect(announcer.textContent?.trim()).toBe("Échec");
  });
});
