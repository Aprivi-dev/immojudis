import { describe, expect, it } from "vitest";
import {
  analysisOfferDescription,
  offerComparisonRows,
  splitOfferComparisonRows,
} from "./offer-comparison";
import { PLAN_FEATURES, PLAN_LIMITS } from "./plans";

describe("offerComparisonRows", () => {
  const rows = offerComparisonRows();
  const row = (id: string) => rows.find((candidate) => candidate.id === id)!;

  it("reprend les droits réels de plans.ts", () => {
    expect(row("ceiling").decouverte.included).toBe(
      PLAN_FEATURES.decouverte["property.bidCeiling"] !== "locked",
    );
    expect(row("ceiling").decouverte).toEqual({
      included: false,
      limited: true,
      text: "3 déblocages par mois",
    });
    expect(row("ceiling").analyse).toEqual({ included: true, text: "Inclus" });
    expect(row("catalogue").decouverte.included).toBe(true);
    expect(row("directory").decouverte.included).toBe(true);
    expect(row("referrals").decouverte.included).toBe(false);
    expect(row("csv").analyse.included).toBe(true);
  });

  it("ne promet pas la mise en relation avec un avocat tant qu'Analyse n'est pas souscriptible", () => {
    expect(row("referrals").analyse).toEqual({ included: false, text: "Pas encore disponible" });
    expect(row("referrals").label).toBe("Mise en relation avec un avocat référencé");
    const open = offerComparisonRows(undefined, { analysisOpen: true });
    expect(open.find((candidate) => candidate.id === "referrals")!.analyse).toEqual({
      included: true,
      text: "Inclus",
    });
  });

  it("chiffre les quotas à partir des limites du plan", () => {
    expect(row("favorites").decouverte.text).toBe("10 favoris");
    // Le plafond n'existe que pour les ventes dont un régime de frais est ouvert : la ligne dit
    // quel terme (enchère ou offre) et quelles ventes.
    expect(row("ceiling").label).toBe("Enchère plafond ou offre plafond chiffrée");
    expect(row("ceiling").hint).toContain(
      "enchère plafond (ventes au tribunal et ventes notariales à la bougie) ou offre plafond (ventes notariales interactives)",
    );
    expect(row("favorites").analyse.text).toBe("Illimités");
    expect(row("alerts").decouverte.text).toBe("1 alerte, email hebdomadaire");
    expect(row("alerts").analyse.text).toBe("Jusqu’à 25, email quotidien");
    expect(row("unlocks").decouverte.text).toBe(
      `${PLAN_LIMITS.decouverte.monthlyUnlocks} déblocages par mois`,
    );
    expect(row("unlocks").decouverte.text).toBe("3 déblocages par mois");
    expect(row("unlocks").analyse.text).toMatch(/^Illimités/);
  });

  it("annonce le statut et le plafond enregistrés dans les avantages Découverte", () => {
    expect(row("dossier").label).toBe("Statut et enchère plafond ou offre plafond enregistrés");
    expect(row("dossier").decouverte).toEqual({ included: true, text: "Inclus" });
    expect(row("dossier").analyse).toEqual({ included: true, text: "Inclus" });
  });

  it("n'écrit « Non inclus » pour aucune ligne qu'un déblocage ouvre", () => {
    const opened = rows.filter((candidate) =>
      ["documents", "document-reading", "passages", "ceiling", "scenarios", "statistics"].includes(
        candidate.id,
      ),
    );
    expect(opened.map((candidate) => candidate.id)).toEqual([
      "ceiling",
      "scenarios",
      "documents",
      "document-reading",
      "passages",
      "statistics",
    ]);
    for (const candidate of opened) {
      expect(candidate.decouverte.text, candidate.id).not.toBe("Non inclus");
      expect(candidate.decouverte.text, candidate.id).toMatch(/^3 déblocages par mois/);
      expect(candidate.decouverte.limited, candidate.id).toBe(true);
      // Fermé dans l'offre : la coche « inclus » reste réservée à ce que l'offre donne vraiment.
      expect(candidate.decouverte.included, candidate.id).toBe(false);
      expect(candidate.analyse.included, candidate.id).toBe(true);
    }
    expect(row("statistics").decouverte.text).toBe("3 déblocages par mois (tribunal de la vente)");
    // L'onglet Travaux reste fermé sur une vente débloquée : le budget travaux n'est pas promis.
    expect(row("scenarios").decouverte.text).toBe(
      "3 déblocages par mois (hors budget travaux détaillé)",
    );
  });

  it("garde « Non inclus » pour ce qu'un déblocage n'ouvre jamais", () => {
    for (const id of ["pdf", "csv", "referrals", "estimate", "land"]) {
      expect(row(id).decouverte, id).toEqual({ included: false, text: "Non inclus" });
    }
  });

  it("dit pourquoi l'estimation détaillée n'est pas incluse alors que le plafond la lit", () => {
    // « Non inclus » est exact : un déblocage ne renvoie que la valeur de référence du plafond.
    expect(row("estimate").decouverte).toEqual({ included: false, text: "Non inclus" });
    expect(row("estimate").hint).toMatch(/valeur de référence entre dans le calcul du plafond/);
    // Les pièces officielles restent annoncées comme ouvertes, sans dépendre du droit d'estimation.
    expect(row("documents").decouverte).toEqual({
      included: false,
      limited: true,
      text: "3 déblocages par mois",
    });
  });

  it("promet les statistiques des ventes et des tribunaux à l'offre Analyse seulement", () => {
    expect(row("statistics").label).toBe("Statistiques des ventes et des tribunaux");
    expect(row("statistics").analyse.included).toBe(true);
    expect(row("statistics").decouverte.included).toBe(false);
    expect(row("statistics").hint).toBe("Tribunaux : selon l’historique disponible");
    expect(row("pdf").analyse.included).toBe(true);
    expect(row("csv").analyse.included).toBe(true);
  });

  it("suit les régimes de frais ouverts pour le nom du plafond et les ventes concernées", () => {
    const tribunalOnly = offerComparisonRows(["tribunal"]);
    const ceiling = tribunalOnly.find((candidate) => candidate.id === "ceiling")!;
    expect(ceiling.label).toBe("Enchère plafond chiffrée");
    expect(ceiling.hint).toContain("enchère plafond (ventes au tribunal)");
    const text = JSON.stringify(tribunalOnly);
    expect(text).not.toMatch(/offre plafond|notariales/);
    expect(tribunalOnly.find((candidate) => candidate.id === "dossier")!.label).toBe(
      "Statut et enchère plafond enregistrés",
    );
  });

  it("met en tête ce qui distingue les offres et range à part ce qui est inclus dans les deux", () => {
    const { differences, shared } = splitOfferComparisonRows(rows);
    // Aucune ligne retirée : les deux groupes couvrent tout le comparatif.
    expect([...differences, ...shared].map((candidate) => candidate.id).sort()).toEqual(
      rows.map((candidate) => candidate.id).sort(),
    );
    expect(differences.map((candidate) => candidate.id)).toEqual([
      "unlocks",
      "ceiling",
      "scenarios",
      "documents",
      "document-reading",
      "passages",
      "alerts",
      "estimate",
      "statistics",
      "pdf",
      "csv",
      "favorites",
      "land",
      "referrals",
    ]);
    expect(shared.map((candidate) => candidate.id)).toEqual([
      "catalogue",
      "dossier",
      "directory",
      "listing-facts",
      "value-range",
    ]);
    // Le groupe « Inclus dans les deux offres » ne contient que des lignes incluses à l'identique.
    for (const candidate of shared) {
      expect(candidate.decouverte, candidate.id).toEqual(candidate.analyse);
      expect(candidate.decouverte.included, candidate.id).toBe(true);
    }
    // Calculé sur les cellules : une ligne qui diffère ne peut pas passer dans le groupe commun.
    for (const candidate of differences) {
      expect(candidate.decouverte, candidate.id).not.toEqual(candidate.analyse);
    }
  });

  it("garde la mise en relation parmi les différences, qu'Analyse soit souscriptible ou non", () => {
    // Fermée dans les deux offres tant qu'Analyse ne se souscrit pas : jamais « incluse dans les deux ».
    expect(splitOfferComparisonRows(rows).shared.map((candidate) => candidate.id)).not.toContain(
      "referrals",
    );
    const open = splitOfferComparisonRows(offerComparisonRows(undefined, { analysisOpen: true }));
    expect(open.differences.map((candidate) => candidate.id)).toContain("referrals");
  });

  it("décrit l'offre Analyse par les ventes qui ont un plafond, selon les régimes ouverts", () => {
    expect(analysisOfferDescription(["tribunal"])).toBe(
      "Le plafond des ventes au tribunal, avant de choisir celles qui méritent une visite.",
    );
    expect(analysisOfferDescription()).toBe(
      "Le plafond des ventes au tribunal ou chez le notaire, avant de choisir celles qui méritent une visite.",
    );
    // Jamais les ventes domaniales, qui n'ont pas de régime de frais.
    expect(analysisOfferDescription()).not.toMatch(/État|domaniales/);
  });

  it("n'expose aucun fournisseur ni « Premium »", () => {
    const text = JSON.stringify(rows);
    expect(text).not.toMatch(/Stripe|Meteostat|ClimaScore|Premium|météo/i);
  });
});
