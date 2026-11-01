// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FollowedSaleSnapshot } from "@/lib/followed-sale-snapshots-shared";
import { PastFollowedSales, averageGapText, gapText, resultText } from "./PastFollowedSales";

const mocks = vi.hoisted(() => ({
  auth: { user: { id: "user-1" } as { id: string } | null, loading: false },
  fetchSnapshots: vi.fn(),
  deleteSnapshot: vi.fn(),
  updateSnapshot: vi.fn(),
  downloadDeadlines: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/hooks/use-auth", () => ({ useAuth: () => mocks.auth }));
vi.mock("@/lib/client-api", () => ({
  fetchFollowedSaleSnapshots: mocks.fetchSnapshots,
  deleteFollowedSaleSnapshot: mocks.deleteSnapshot,
  updateFollowedSaleSnapshot: mocks.updateSnapshot,
  downloadSnapshotDeadlines: mocks.downloadDeadlines,
}));
vi.mock("@/lib/toast", () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));

function snapshot(overrides: Partial<FollowedSaleSnapshot> = {}): FollowedSaleSnapshot {
  return {
    id: "snap-1",
    saleId: "sale-1",
    capturedAt: "2026-10-14T12:05:00.000Z",
    expiresAt: "2027-04-14T12:05:00.000Z",
    title: "Maison de ville",
    city: "Bordeaux",
    department: "33",
    propertyType: "house",
    tribunalName: "Tribunal judiciaire de Bordeaux",
    startingPriceEur: 100_000,
    saleDate: "2026-10-14T12:00:00.000Z",
    lawyerName: "Me Dupont",
    sourceName: "vench",
    result: { status: "unknown", priceEur: null, priceSource: null, priceWithheld: false },
    personalStatus: null,
    bidCeilingEur: null,
    finalPriceEur: null,
    saleVenueType: "tribunal",
    saleLegalFramework: "judicial_seizure",
    surenchere: {
      kind: "window",
      hearingDay: "2026-10-14",
      deadline: "2026-10-24",
      adjudicationConfirmed: false,
      expired: false,
    },
    ...overrides,
  };
}

function renderSection() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <PastFollowedSales />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.auth.user = { id: "user-1" };
  mocks.auth.loading = false;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("resultText", () => {
  it("n'affiche un prix que s'il est publié, avec sa source", () => {
    expect(
      resultText({
        status: "adjudicated",
        priceEur: 250_000,
        priceSource: "vench",
        priceWithheld: false,
      }),
    ).toMatch(/^Adjugé à 250\s000\s€ \(source : vench\)\.$/);
  });

  it("dit « non connu » plutôt que de déduire un prix", () => {
    expect(
      resultText({
        status: "adjudicated",
        priceEur: null,
        priceSource: null,
        priceWithheld: false,
      }),
    ).toBe("Adjugé. Prix d’adjudication non connu.");
    expect(
      resultText({ status: "unknown", priceEur: null, priceSource: null, priceWithheld: false }),
    ).toBe("Résultat non connu.");
  });

  it("distingue un prix réservé à l'offre Analyse d'un prix non connu", () => {
    expect(
      resultText({ status: "adjudicated", priceEur: null, priceSource: null, priceWithheld: true }),
    ).toBe("Adjugé. Le prix d’adjudication est réservé à l’offre Analyse.");
  });
});

describe("PastFollowedSales (ventes passées)", () => {
  it("n'affiche rien sans compte ou sans instantané", async () => {
    mocks.fetchSnapshots.mockResolvedValue({ snapshots: [] });
    const { container } = renderSection();
    await waitFor(() => expect(mocks.fetchSnapshots).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");

    cleanup();
    mocks.auth.user = null;
    const anonymous = renderSection();
    expect(anonymous.container.innerHTML).toBe("");
  });

  it("montre les données clés, le résultat inconnu et la fenêtre de surenchère avec le renvoi à l'avocat", async () => {
    mocks.fetchSnapshots.mockResolvedValue({ snapshots: [snapshot()] });
    renderSection();

    expect(await screen.findByRole("heading", { name: "Maison de ville" })).toBeTruthy();
    expect(screen.getByText("Bordeaux (33) · Maison")).toBeTruthy();
    expect(screen.getByText("Tribunal judiciaire de Bordeaux")).toBeTruthy();
    expect(screen.getByTestId("snapshot-result").textContent).toBe("Résultat non connu.");

    const surenchere = screen.getByTestId("snapshot-surenchere").textContent ?? "";
    expect(surenchere).toContain("Le résultat n’est pas connu");
    expect(surenchere).toContain(
      "Date indicative : le 24 octobre 2026. Si ce jour tombe un samedi, un dimanche ou un jour férié, le délai peut être prolongé jusqu’au premier jour ouvrable suivant ; ne comptez pas dessus sans l’avis d’un avocat. Elle est calculée à partir de la date d’audience connue d’Immojudis, qui peut avoir changé.",
    );
    expect(surenchere).toContain(
      "par acte d’avocat déposé au greffe du juge de l’exécution, avec une garantie d’un dixième du prix principal (chèque de banque ou caution bancaire irrévocable, art. R. 322-51 du CPCE)",
    );
    expect(surenchere).toContain("de préférence inscrit au barreau du tribunal concerné");
    expect(surenchere).toContain(
      "le choix vous appartient (l’annuaire d’Immojudis signale les profils mis en avant contre rémunération)",
    );
    expect(surenchere).not.toContain("l’avocat de la vente");
    expect(surenchere).not.toContain("Me Dupont");
    // Formulation prudente : ni compte à rebours, ni « dernier jour », ni « échue ».
    expect(surenchere).not.toMatch(/Il reste|dernier jour|échue/);
    // Le lien de l'annuaire est filtré sur le barreau du tribunal.
    expect(screen.getByRole("link", { name: "l’annuaire d’Immojudis" }).getAttribute("href")).toBe(
      "/avocats?bar=Bordeaux",
    );
    expect(screen.getByText(/Gardé jusqu’au 14 avril 2027/)).toBeTruthy();
  });

  it("affiche le prix publié et sa source, et la date limite d'une vente adjugée", async () => {
    mocks.fetchSnapshots.mockResolvedValue({
      snapshots: [
        snapshot({
          result: {
            status: "adjudicated",
            priceEur: 250_000,
            priceSource: "vench",
            priceWithheld: false,
          },
          personalStatus: "bidding",
          bidCeilingEur: 180_000,
          surenchere: {
            kind: "window",
            hearingDay: "2026-10-14",
            deadline: "2026-10-24",
            adjudicationConfirmed: true,
            expired: false,
          },
        }),
      ],
    });
    renderSection();

    await screen.findByRole("heading", { name: "Maison de ville" });
    expect(screen.getByTestId("snapshot-result").textContent).toMatch(/Adjugé à 250\s000\s€/);
    expect((screen.getByLabelText("Mon résultat") as HTMLSelectElement).value).toBe("bidding");
    expect(screen.getByText(/180\s000\s€/)).toBeTruthy();
    const surenchere = screen.getByTestId("snapshot-surenchere").textContent ?? "";
    expect(surenchere).toContain(
      "Date indicative : le 24 octobre 2026. Si ce jour tombe un samedi",
    );
    expect(surenchere).not.toMatch(/Il reste|dernier jour|échue/);
    expect(surenchere).not.toContain("passée");
  });

  it("affiche les valeurs absentes comme absentes", async () => {
    mocks.fetchSnapshots.mockResolvedValue({
      snapshots: [
        snapshot({
          title: null,
          city: null,
          department: null,
          propertyType: null,
          tribunalName: null,
          startingPriceEur: null,
          lawyerName: null,
          saleDate: null,
          surenchere: { kind: "no_date" },
        }),
      ],
    });
    renderSection();

    expect(await screen.findByRole("heading", { name: "Vente sans titre" })).toBeTruthy();
    expect(screen.getByText("Date non connue")).toBeTruthy();
    expect(screen.getAllByText("Non renseigné")).toHaveLength(2);
    expect(screen.getByText("Prix non communiqué")).toBeTruthy();
    expect(screen.getByText("Aucun enregistré")).toBeTruthy();
    expect(screen.getByTestId("snapshot-surenchere").textContent).toContain(
      "La date d’audience n’est pas connue",
    );
  });

  it("n'annonce pas de fenêtre pour une vente qui n'est pas judiciaire, ni après l'échéance", async () => {
    mocks.fetchSnapshots.mockResolvedValue({
      snapshots: [
        snapshot({ id: "a", surenchere: { kind: "not_applicable" } }),
        snapshot({
          id: "b",
          title: "Vente échue",
          surenchere: {
            kind: "window",
            hearingDay: "2026-09-01",
            deadline: "2026-09-11",
            adjudicationConfirmed: true,
            expired: true,
          },
        }),
      ],
    });
    renderSection();

    await screen.findByRole("heading", { name: "Vente échue" });
    const blocks = screen.getAllByTestId("snapshot-surenchere").map((node) => node.textContent);
    expect(blocks[0]).toContain("Non déterminée pour ce type de vente");
    expect(blocks[1]).toContain(
      "Cette date indicative est passée : le délai a pu expirer, ou être prolongé. Si vous êtes concerné, consultez sans attendre un avocat, seul à pouvoir le confirmer.",
    );
    expect(blocks[1]).toContain("Date indicative : le 11 septembre 2026");
    expect(blocks[1]).not.toMatch(/Il reste|dernier jour|échue/);
  });

  it("retire un instantané à la demande de la personne", async () => {
    mocks.fetchSnapshots
      .mockResolvedValueOnce({ snapshots: [snapshot()] })
      .mockResolvedValueOnce({ snapshots: [] });
    mocks.deleteSnapshot.mockResolvedValue({ ok: true, removed: true });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { container } = renderSection();

    fireEvent.click(await screen.findByRole("button", { name: "Retirer de mon espace" }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("ne pourra pas être rétabli"));

    await waitFor(() => expect(mocks.deleteSnapshot).toHaveBeenCalledWith({ id: "snap-1" }));
    await waitFor(() => expect(container.innerHTML).toBe(""));
    expect(mocks.toastSuccess).toHaveBeenCalled();
  });

  it("ne retire rien quand la personne refuse la confirmation", async () => {
    mocks.fetchSnapshots.mockResolvedValue({ snapshots: [snapshot()] });
    vi.spyOn(window, "confirm").mockReturnValue(false);
    renderSection();

    fireEvent.click(await screen.findByRole("button", { name: "Retirer de mon espace" }));

    expect(mocks.deleteSnapshot).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Maison de ville" })).toBeTruthy();
  });

  it("définit la surenchère et l'adjudication avec le composant Terme", async () => {
    mocks.fetchSnapshots.mockResolvedValue({ snapshots: [snapshot()] });
    renderSection();

    await screen.findByRole("heading", { name: "Maison de ville" });
    expect(screen.getByRole("button", { name: "Définition : surenchère" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Définition : adjudication" })).toBeTruthy();
  });

  it("annonce une indisponibilité sans afficher d'erreur technique", async () => {
    mocks.fetchSnapshots.mockRejectedValue(
      new Error("Ventes passées indisponibles pour le moment."),
    );
    renderSection();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("indisponibles");
  });
});

describe("gapText", () => {
  it("dit l'écart avec le plafond sans le présenter comme une consigne", () => {
    expect(gapText({ eur: 12_000, pct: 7 })).toMatch(
      /12\s000\s€ de plus que votre plafond \(\+7 %\)/,
    );
    expect(gapText({ eur: -5_000, pct: -3 })).toMatch(
      /5\s000\s€ de moins que votre plafond \(−3 %\)/,
    );
    expect(gapText({ eur: 0, pct: 0 })).toBe("égal à votre plafond");
  });
});

describe("averageGapText", () => {
  it("dit le sens de l'écart moyen en pourcentage", () => {
    expect(averageGapText(7)).toBe("7 % au-dessus de votre plafond");
    expect(averageGapText(-3)).toBe("3 % en dessous de votre plafond");
    expect(averageGapText(0)).toBe("égal à votre plafond");
  });
});

describe("PastFollowedSales : bilan après adjudication", () => {
  it("enregistre le statut puis le prix final, facultatif, quand la vente est remportée", async () => {
    mocks.fetchSnapshots.mockResolvedValue({
      snapshots: [snapshot({ personalStatus: "won", bidCeilingEur: 180_000 })],
    });
    mocks.updateSnapshot.mockResolvedValue({ snapshot: snapshot() });
    renderSection();

    const price = await screen.findByLabelText("Prix final de l’adjudication (facultatif)");
    fireEvent.change(price, { target: { value: "172 500" } });
    fireEvent.click(screen.getByRole("button", { name: "Enregistrer" }));

    await waitFor(() =>
      expect(mocks.updateSnapshot).toHaveBeenCalledWith({
        data: { id: "snap-1", finalPriceEur: 172_500 },
      }),
    );
    expect(mocks.toastSuccess).toHaveBeenCalled();
  });

  it("refuse un montant illisible sans rien envoyer", async () => {
    mocks.fetchSnapshots.mockResolvedValue({ snapshots: [snapshot({ personalStatus: "lost" })] });
    renderSection();

    fireEvent.change(await screen.findByLabelText("Prix final de l’adjudication (facultatif)"), {
      target: { value: "185.000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Enregistrer" }));

    expect((await screen.findByRole("alert")).textContent).toContain("chiffres seulement");
    expect(mocks.updateSnapshot).not.toHaveBeenCalled();
  });

  it("ne propose pas de prix final sans statut remporté ou non remporté", async () => {
    mocks.fetchSnapshots.mockResolvedValue({
      snapshots: [snapshot({ personalStatus: "watching" })],
    });
    renderSection();

    await screen.findByRole("heading", { name: "Maison de ville" });
    expect(screen.queryByLabelText("Prix final de l’adjudication (facultatif)")).toBeNull();
    expect(screen.queryByTestId("snapshot-gap")).toBeNull();
    expect(screen.queryByTestId("snapshot-balance")).toBeNull();
  });

  it("change le statut depuis la liste « Mon résultat »", async () => {
    mocks.fetchSnapshots.mockResolvedValue({ snapshots: [snapshot()] });
    mocks.updateSnapshot.mockResolvedValue({ snapshot: snapshot() });
    renderSection();

    fireEvent.change(await screen.findByLabelText("Mon résultat"), { target: { value: "won" } });

    await waitFor(() =>
      expect(mocks.updateSnapshot).toHaveBeenCalledWith({
        data: { id: "snap-1", personalStatus: "won" },
      }),
    );
  });

  it("montre l'écart avec le plafond seulement si le prix final et le plafond sont notés", async () => {
    mocks.fetchSnapshots.mockResolvedValue({
      snapshots: [
        snapshot({
          id: "a",
          title: "Avec écart",
          personalStatus: "won",
          bidCeilingEur: 180_000,
          finalPriceEur: 171_000,
        }),
        snapshot({
          id: "b",
          title: "Sans plafond",
          personalStatus: "lost",
          bidCeilingEur: null,
          finalPriceEur: 250_000,
        }),
      ],
    });
    renderSection();

    await screen.findByRole("heading", { name: "Avec écart" });
    const gaps = screen.getAllByTestId("snapshot-gap").map((node) => node.textContent ?? "");
    expect(gaps[0]).toMatch(/9\s000\s€ de moins que votre plafond \(−5 %\)/);
    expect(gaps[1]).toContain("aucun plafond n’était enregistré");
  });

  it("résume les ventes remportées et non remportées sans prévision", async () => {
    mocks.fetchSnapshots.mockResolvedValue({
      snapshots: [
        snapshot({
          id: "a",
          title: "A",
          personalStatus: "won",
          bidCeilingEur: 100_000,
          finalPriceEur: 90_000,
        }),
        snapshot({
          id: "b",
          title: "B",
          personalStatus: "won",
          bidCeilingEur: 200_000,
          finalPriceEur: 220_000,
        }),
        snapshot({ id: "c", title: "C", personalStatus: "lost" }),
      ],
    });
    renderSection();

    const balance = await screen.findByTestId("snapshot-balance");
    const text = balance.textContent ?? "";
    expect(text).toContain("Ventes remportées : 2");
    expect(text).toContain("prix final en moyenne égal à votre plafond, sur 2 ventes");
    expect(text).toContain("1 au-dessus de votre plafond");
    expect(text).toContain("Ventes non remportées : 1");
    expect(text).toContain("aucun prix final noté avec un plafond");
    expect(text).toContain("Ce n’est pas une prévision");
  });

  it("affiche l'échéancier indicatif d'une saisie remportée, avec sources et mention avocat", async () => {
    mocks.fetchSnapshots.mockResolvedValue({ snapshots: [snapshot({ personalStatus: "won" })] });
    renderSection();

    const block = await screen.findByTestId("snapshot-deadlines");
    const text = block.textContent ?? "";
    // Audience le 14 octobre 2026 : surenchère au plus tôt le 24 octobre, paiement le 24 décembre.
    expect(text).toContain("Fin du délai de surenchère, au plus tôt : 24 octobre 2026");
    expect(text).toContain("art. R. 322-50 du CPCE");
    expect(text).toContain("Paiement du prix, au plus tôt : 24 décembre 2026");
    expect(text).toContain("art. R. 322-56 du CPCE");
    expect(text).toContain("À confirmer avec votre avocat.");
    expect(text).not.toMatch(/Il reste|dernier jour|échue/);
  });

  it("n'annonce pas d'échéancier pour une autre procédure qu'une saisie immobilière", async () => {
    mocks.fetchSnapshots.mockResolvedValue({
      snapshots: [snapshot({ personalStatus: "won", saleLegalFramework: "insolvency" })],
    });
    renderSection();

    const text = (await screen.findByTestId("snapshot-deadlines")).textContent ?? "";
    expect(text).toContain("Nous ne calculons pas d’échéancier pour cette vente");
    expect(screen.queryByRole("button", { name: /Ajouter l’échéancier/ })).toBeNull();
  });

  it("n'affiche aucun échéancier tant que la vente n'est pas marquée remportée", async () => {
    mocks.fetchSnapshots.mockResolvedValue({ snapshots: [snapshot({ personalStatus: "lost" })] });
    renderSection();

    await screen.findByRole("heading", { name: "Maison de ville" });
    expect(screen.queryByTestId("snapshot-deadlines")).toBeNull();
  });

  it("télécharge l'échéancier en .ics", async () => {
    mocks.fetchSnapshots.mockResolvedValue({ snapshots: [snapshot({ personalStatus: "won" })] });
    mocks.downloadDeadlines.mockResolvedValue({
      blob: new Blob(["BEGIN:VCALENDAR"]),
      filename: "immojudis-echeancier-snap.ics",
    });
    URL.createObjectURL = vi.fn(() => "blob:test");
    URL.revokeObjectURL = vi.fn();
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    renderSection();

    fireEvent.click(
      await screen.findByRole("button", { name: "Ajouter l’échéancier à mon agenda (.ics)" }),
    );

    await waitFor(() =>
      expect(mocks.downloadDeadlines).toHaveBeenCalledWith({ snapshotId: "snap-1" }),
    );
    await waitFor(() => expect(click).toHaveBeenCalled());
  });
});
