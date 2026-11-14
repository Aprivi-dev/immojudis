import { describe, expect, it } from "vitest";
import {
  describeOperationalAlert,
  operationalAlertNotificationLabel,
  operationalAlertSeverityLabel,
} from "./operational-alert-labels";

describe("describeOperationalAlert", () => {
  it("names the five alerts open in production on 14/11/2026, with where to act", () => {
    expect(describeOperationalAlert("information_agent.unrouted.pending")).toEqual({
      label: "Messages reçus sans dossier, en attente de traitement",
      place: { href: "/admin/agent-ia?onglet=reponses", label: "Agent IA › Réponses" },
    });
    expect(describeOperationalAlert("pipeline.enrichment.exhausted").place.href).toBe(
      "/admin/operations",
    );
    expect(describeOperationalAlert("pipeline.enrichment.stalled").label).toBe(
      "Enrichissement des fiches à l’arrêt",
    );
    expect(
      describeOperationalAlert("pipeline.source.encheres_immobilieres.stale_listings").label,
    ).toBe("Source Enchères Immobilières : fiches non revérifiées à temps");
    expect(describeOperationalAlert("pipeline.source.notaires.stale_listings").label).toBe(
      "Source Immobilier.notaires : fiches non revérifiées à temps",
    );
  });

  it("covers the keys built from a variable name", () => {
    expect(describeOperationalAlert("pipeline.source.licitor.missed").label).toBe(
      "Source Licitor : inventaire complet en retard",
    );
    expect(describeOperationalAlert("pipeline.source.agrasc.nouveau_controle").label).toBe(
      "Source AGRASC : anomalie de collecte",
    );
    expect(describeOperationalAlert("catalogue.source_absence.cessions_etat").label).toBe(
      "Source Cessions de l'Etat : trop de ventes absentes d’un coup, retrait bloqué",
    );
    // Une source absente de la table des noms garde son nom de supervision.
    expect(describeOperationalAlert("pipeline.source.test_source.drop").label).toBe(
      "Source test_source : nombre d’annonces en forte baisse",
    );
    expect(describeOperationalAlert("catalogue.quality.land_with_rooms").place.href).toBe(
      "/admin/quality",
    );
    expect(describeOperationalAlert("fact_registry.projection_drift").label).toBe(
      "Registre des pièces : contrôle de cohérence",
    );
    expect(describeOperationalAlert("information_agent.autopilot.warning.bounce_rate").label).toBe(
      "Pilote de l’Agent IA proche d’un seuil d’arrêt",
    );
    // Clé réelle, lue par sa famille : le module ne nomme pas la table privée des loyers.
    expect(describeOperationalAlert("reference.anil_rents.stale")).toEqual({
      label: "Référentiel externe (loyers, zonage) à actualiser",
      place: { href: "/admin/settings", label: "Configuration" },
    });
  });

  it("gives an unknown key a readable fallback, never the raw key", () => {
    for (const key of [
      "pipeline.nouvelle.alerte",
      "information_agent.autre",
      "inconnue.cle",
      "constructor",
      "toString.valueOf",
      "",
    ]) {
      const { label, place } = describeOperationalAlert(key);
      expect(label).not.toContain(".");
      expect(label).not.toBe(key);
      expect(place.href.startsWith("/admin/")).toBe(true);
    }
    expect(describeOperationalAlert("pipeline.nouvelle.alerte").label).toBe(
      "Alerte de collecte non répertoriée",
    );
    expect(describeOperationalAlert("inconnue.cle").label).toBe(
      "Alerte d’exploitation non répertoriée",
    );
  });
});

describe("severity and notification labels", () => {
  it("translates the values allowed by the database, with a fallback", () => {
    expect(operationalAlertSeverityLabel("critical")).toBe("Critique");
    expect(operationalAlertSeverityLabel("warning")).toBe("Avertissement");
    expect(operationalAlertSeverityLabel("constructor")).toBe("Gravité inconnue");
    expect(operationalAlertNotificationLabel("pending")).toBe("En attente");
    expect(operationalAlertNotificationLabel("processing")).toBe("En cours d’envoi");
    expect(operationalAlertNotificationLabel("delivered")).toBe("Envoyée");
    expect(operationalAlertNotificationLabel("failed")).toBe("En échec");
    expect(operationalAlertNotificationLabel("autre")).toBe("État inconnu");
  });
});
