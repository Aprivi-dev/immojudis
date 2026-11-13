import { describe, expect, it } from "vitest";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import { buildOccupancyAnalysis } from "@/lib/occupation-analysis";

describe("occupation analysis", () => {
  const cleanSale = {
    ...EXAMPLE_SALE,
    description: "Appartement.",
    source_description: null,
    llm_display_description: null,
    about_description: null,
    investment_summary: null,
    risk_notes: null,
    source_blocks: {},
    source_blocks_by_source: {},
    score_factors: [],
    documents_rich: [],
    risks: [],
  };

  it("does not treat copies of one publication as independent confirmation", () => {
    const text = "Studio loué avec bail en cours.";
    const analysis = buildOccupancyAnalysis({
      ...cleanSale,
      occupancy_status: "rented",
      description: text,
      source_description: text,
      source_blocks: { page_text: text, occupation: "rented" },
      source_blocks_by_source: { licitor: { page_text: text, occupation: "rented" } },
    });
    expect(analysis.status).toBe("rented");
    expect(analysis.confidence).toBe("medium");
    expect(analysis.confidenceLabel).toBe("Statut repéré, à confirmer");
  });

  it.each(["Présence d'un meuble", "Présence d’un placard", "Présence d’une fenêtre"])(
    "does not turn a physical observation into occupation: %s",
    (description) => {
      const analysis = buildOccupancyAnalysis({
        ...cleanSale,
        occupancy_status: "rented",
        description,
      });
      expect(analysis.status).toBe("rented");
      expect(analysis.evidence).toHaveLength(1);
    },
  );

  // Le champ est un code de la base : il se lit par sa classe (`occupancyClass`), pas par les motifs
  // des textes, que `owner_occupied` ou `squatted` ne déclenchaient pas (« À confirmer » avant le lot 10).
  it.each([
    ["occupied", "Occupé"],
    ["owner_occupied", "Occupé par le propriétaire"],
    ["squatted", "Occupé sans droit ni titre"],
  ])("qualifies the structured status %s as occupied", (occupancy_status, label) => {
    const analysis = buildOccupancyAnalysis({ ...cleanSale, occupancy_status });
    expect(analysis).toMatchObject({
      status: "occupied",
      label: "Occupé",
      confidence: "medium",
      confidenceLabel: "Statut repéré, à confirmer",
    });
    expect(analysis.evidence).toEqual([
      { status: "occupied", label, excerpt: label, source: "Champ occupation" },
    ]);
  });

  // Relecture juridique du 13/11/2026 : un statut lu sur le seul champ le dit, et un bien occupé
  // renvoie l'estimation du délai de libération à un conseil.
  it("says when the status rests on the collected field alone, and sends the eviction delay to counsel", () => {
    const occupied = buildOccupancyAnalysis({ ...cleanSale, occupancy_status: "occupied" });
    expect(occupied.limitations).toEqual(
      expect.arrayContaining([
        "Le statut provient des données collectées sur la vente ; aucun extrait de pièce ne le confirme dans ce rapport.",
        "Le délai de libération dépend du statut de l'occupant et de la procédure d'expulsion applicable ; il est à faire estimer par un conseil.",
      ]),
    );
    const rented = buildOccupancyAnalysis({ ...cleanSale, occupancy_status: "rented" });
    expect(rented.limitations).toContain(
      "Le statut provient des données collectées sur la vente ; aucun extrait de pièce ne le confirme dans ce rapport.",
    );
    expect(rented.limitations.join(" ")).not.toContain("délai de libération");
  });

  it("flags an occupied structured status contradicted by a vacant text", () => {
    const analysis = buildOccupancyAnalysis({
      ...cleanSale,
      occupancy_status: "squatted",
      description: "Appartement libre de toute occupation.",
    });
    expect(analysis.status).toBe("conflicting");
  });

  it("treats rented and occupied as compatible signals", () => {
    const analysis = buildOccupancyAnalysis({
      ...cleanSale,
      occupancy_status: "rented",
      source_description: "Présence d’une personne dans le logement.",
    });
    expect(analysis.status).toBe("rented");
    expect(analysis.evidence.map((item) => item.status)).toContain("occupied");
  });

  it("keeps a late contradiction in the decision and visible evidence", () => {
    const analysis = buildOccupancyAnalysis({
      ...cleanSale,
      occupancy_status: "vacant",
      source_blocks: {
        ...Object.fromEntries(
          Array.from({ length: 10 }, (_, i) => [
            `occupation_${i}`,
            `Libre de toute occupation, constat ${i}.`,
          ]),
        ),
        occupation_finale: "Présence d’une personne dans le logement.",
      },
    });
    expect(analysis.status).toBe("conflicting");
    expect(analysis.evidence).toHaveLength(8);
    expect(analysis.evidence.map((item) => item.status)).toEqual(
      expect.arrayContaining(["free", "occupied"]),
    );
  });

  it("does not treat vacancy at a historical inspection as current availability", () => {
    const analysis = buildOccupancyAnalysis({
      ...EXAMPLE_SALE,
      occupancy_status: "vacant",
      source_description: "Le logement était inoccupé lors du constat.",
      source_blocks: {},
      risks: [],
    });
    expect(analysis.status).toBe("to_confirm");
    expect(analysis.summary).toContain("Inoccupé au constat");
    expect(analysis.summary).toContain("disponibilité actuelle reste à confirmer");
  });
  it("qualifies free properties from a structured status and source confirmation", () => {
    const analysis = buildOccupancyAnalysis({
      ...EXAMPLE_SALE,
      occupancy_status: "vacant",
      source_blocks: {
        occupation: "Libre de toute occupation",
      },
      risks: [],
    });

    expect(analysis).toMatchObject({
      available: true,
      status: "free",
      label: "Libre",
      confidence: "medium",
      hasLeaseSignal: false,
    });
    expect(analysis.decisionImpact).toContain("jouissance");
  });

  it("detects lease and tenant signals even when the structured status is unknown", () => {
    const analysis = buildOccupancyAnalysis({
      ...EXAMPLE_SALE,
      occupancy_status: "unknown",
      description: "Appartement loué selon bail d'habitation, loyer mensuel à vérifier.",
      risks: [],
    });

    expect(analysis).toMatchObject({
      available: true,
      status: "rented",
      label: "Loué",
      hasLeaseSignal: true,
    });
    expect(analysis.nextActions).toEqual(
      expect.arrayContaining([
        "Relever bail, loyer, dépôt, impayés, durée restante et clauses de sortie.",
      ]),
    );
  });

  // Jusqu'au lot 12, la contradiction venait d'un risque de l'exemple (« sans bail annexé au
  // dossier ») lu « Loué », et « bail non produit » masquait l'occupant déclaré : le texte qui
  // contredit le champ est maintenant seul en jeu.
  it("flags conflicting occupancy signals before bidding assumptions are fixed", () => {
    const analysis = buildOccupancyAnalysis({
      ...cleanSale,
      occupancy_status: "vacant",
      description: "Présence d'une personne se déclarant occupante, bail non produit.",
    });

    expect(analysis).toMatchObject({
      available: true,
      status: "conflicting",
      confidence: "low",
      confidenceLabel: "Signaux contradictoires à arbitrer",
    });
    expect(analysis.decisionImpact).toContain("enchère plafond");
  });

  it("keeps unknown occupation explicit when only weak source data is present", () => {
    const analysis = buildOccupancyAnalysis({
      ...EXAMPLE_SALE,
      occupancy_status: "unknown",
      description: "Appartement T2 avec balcon.",
      source_description: null,
      llm_display_description: null,
      about_description: null,
      investment_summary: null,
      risk_notes: null,
      source_blocks: null,
      source_blocks_by_source: null,
      score_factors: [],
      documents_rich: [],
      risks: [],
    });

    expect(analysis).toMatchObject({
      available: true,
      status: "to_confirm",
      confidence: "low",
      summary: "À confirmer · 1 indice(s).",
    });
    expect(analysis.limitations[0]).toContain("ne permet pas encore");
  });

  // Test de caractérisation (lot 11) : des textes réels typiques des annonces et des blocs
  // source, lus avec un statut inconnu. Colonnes : où le texte se trouve, le texte, le statut
  // rendu. « libre » et « vide » ne comptent que dans une phrase d'occupation : les lignes sous
  // « avant : free » étaient de faux « Libre » (relecture juridique du 13/11/2026).
  it.each([
    ["description", "Appartement libre.", "free"],
    ["description", "Maison libre avec jardin.", "free"],
    ["description", "Le lot 1 est libre de toute occupation", "free"],
    ["description", "Libre de toute occupation.", "free"],
    ["description", "Lot vendu libre", "free"],
    ["description", "Appartement vendu libre de tout occupant.", "free"],
    ["description", "Maison libre dès la signature de l'acte.", "free"],
    ["description", "Vendu libre.", "free"],
    ["description", "Le bien était loué mais il est désormais libre", "free"],
    ["description", "Logement vide de tout occupant.", "free"],
    ["description", "Bien inoccupé depuis 2024.", "free"],
    ["description", "Appartement loué selon bail d'habitation.", "rented"],
    ["description", "Appartement occupé par le propriétaire.", "occupied"],
    // avant : free
    ["description", "Appartement loué vide.", "rented"],
    ["description", "Maison sur vide sanitaire, chauffage au fioul.", "to_confirm"],
    ["description", "Vide sanitaire.", "to_confirm"],
    ["description", "Accès libre au jardin.", "to_confirm"],
    ["description", "Parking en accès libre devant l'immeuble.", "to_confirm"],
    ["description", "Présence d'un vide-ordures dans les parties communes.", "to_confirm"],
    ["description", "Bien vendu libre de toute inscription hypothécaire.", "to_confirm"],
    // « vacant » après le bien vendu (lot 12), sauf nié ou statistique de la commune
    ["description", "Logement vacant depuis 2023.", "free"],
    ["description", "Appartement vacant.", "free"],
    // avant : to_confirm
    ["description", "Maison vacante.", "free"],
    // avant : free
    ["description", "Aucun logement vacant.", "to_confirm"],
    ["description", "Aucun logement libre.", "to_confirm"],
    // statistique de la commune, pas l'occupation du bien
    ["description", "Part des logements vacants dans la commune : 8 %.", "to_confirm"],
    ["description", "Taxe sur les logements vacants applicable.", "to_confirm"],
    // désignation seule d'un bail (lot 12)
    ["description", "Bail commercial.", "rented"],
    ["description", "Bail d'habitation.", "rented"],
    // location en cours : « bail » et « loyer » dans une phrase de location (lot 12)
    ["description", "Studio loué avec bail en cours.", "rented"],
    ["description", "Local commercial, bail commercial en cours.", "rented"],
    ["description", "Bail d'habitation en cours.", "rented"],
    ["description", "Locataire en place.", "rented"],
    ["description", "Le bien est occupé par un occupant suivant bail du 3 mars 2021.", "rented"],
    ["description", "Locaux occupés en vertu d'un bail commercial.", "rented"],
    ["description", "Local commercial donné à bail.", "rented"],
    ["description", "Loyer mensuel de 650 € hors charges.", "rented"],
    ["description", "Loyer annuel de 12 000 € HT.", "rented"],
    ["description", "Moyennant un loyer mensuel de 480 euros.", "rented"],
    // avant : to_confirm (le pluriel « loyers » n'était pas lu)
    ["description", "Loyers perçus : 6 000 € par an.", "rented"],
    // blocs source nommés d'après l'occupation
    ["occupation", "Libre de toute occupation", "free"],
    ["occupation", "Libre", "free"],
    ["situationLocative", "LIBRE", "free"],
    ["critere_occupation_du_bien", "Libre de toute occupation", "free"],
    ["occupancy_status", "vacant", "free"],
    ["occupancy", "free", "free"],
    // valeur d'un champ nommé d'après le bail ou l'occupation (lot 12)
    ["bail", "Bail commercial", "rented"],
    ["situationLocative", "Bail d'habitation", "rented"],
    ["occupancy", "tenant", "rented"],
    // avant : rented
    ["bail", "aucun", "to_confirm"],
  ])("lit « %s : %s » comme %s", (where, text, status) => {
    const analysis = buildOccupancyAnalysis({
      ...cleanSale,
      occupancy_status: "unknown",
      ...(where === "description" ? { description: text } : { source_blocks: { [where]: text } }),
    });
    expect(analysis.status).toBe(status);
  });

  // Lot 12 : « free » hors d'un champ d'occupation, « vacant » hors du bien vendu, « bail » et
  // « loyer » hors d'une phrase de location en cours ou d'une désignation de bail, « tenant » dans un
  // texte ne disent rien de l'occupation. Avant, chacune de ces phrases était lue « Libre » (les deux
  // premières) ou « Loué » avec un signal de bail.
  it.each([
    "Appartement T2, éligible à la fibre (Orange, Free, SFR).",
    "Terrain vacant à proximité, appartement au 2e étage.",
    "Box fermé, loyer de marché estimé à 80 euros.",
    "Loyer potentiel de 650 € par mois.",
    "Loyer mensuel estimé à 600 € charges comprises.",
    "Terrain ayant fait l'objet d'un bail à construction expiré en 2010.",
    "Ancien bail commercial résilié en 2019.",
    "Présence lors du constat, sans bail annexé au dossier.",
    "Le bail commercial a été signé en 1990 puis résilié.",
    "Aucun bail en cours.",
    "Pas de loyer perçu.",
    "Mise à prix fixée en tenant compte de l'état du bien.",
  ])("ne lit aucune occupation dans « %s »", (description) => {
    const analysis = buildOccupancyAnalysis({
      ...cleanSale,
      occupancy_status: "unknown",
      description,
    });
    expect(analysis).toMatchObject({
      status: "to_confirm",
      label: "À confirmer",
      hasLeaseSignal: false,
    });
  });

  // Avant le lot 12, « bail non produit » (à confirmer) masquait l'occupant déclaré.
  it("garde l'occupant déclaré quand le bail n'est pas produit", () => {
    const analysis = buildOccupancyAnalysis({
      ...cleanSale,
      occupancy_status: "unknown",
      description:
        "Présence d'une personne se déclarant occupante ; bail non produit dans les pièces communiquées.",
    });
    expect(analysis.status).toBe("occupied");
    expect(analysis.evidence).toContainEqual(
      expect.objectContaining({ status: "occupied", source: "Description annonce" }),
    );
  });

  it.each([
    { type: "bail", document_type: "bail", label: "Bail" },
    { type: null, label: "Bail commercial du 1er janvier 2015" },
  ])("lit une pièce du dossier qui est un bail comme un indice de location : %j", (piece) => {
    const analysis = buildOccupancyAnalysis({
      ...cleanSale,
      occupancy_status: "unknown",
      documents_rich: [{ url: "https://example.test/bail.pdf", extraction_status: null, ...piece }],
    });
    expect(analysis).toMatchObject({ status: "rented", hasLeaseSignal: true });
    expect(analysis.evidence).toContainEqual({
      status: "rented",
      label: "Loué",
      excerpt: piece.label,
      source: "Pièces du dossier",
    });
  });

  it("ne lit pas une autre pièce du dossier comme un bail", () => {
    const analysis = buildOccupancyAnalysis({
      ...cleanSale,
      occupancy_status: "unknown",
      documents_rich: [
        {
          url: "https://example.test/ccv.pdf",
          extraction_status: null,
          type: "cahier_conditions_vente",
          label: "Cahier des conditions de vente",
        },
      ],
    });
    expect(analysis).toMatchObject({ status: "to_confirm", hasLeaseSignal: false });
  });

  it("ne lit pas l'opérateur Free comme un démenti d'un bien occupé", () => {
    const analysis = buildOccupancyAnalysis({
      ...cleanSale,
      occupancy_status: "occupied",
      description: "Appartement T2, éligible à la fibre (Orange, Free, SFR).",
    });
    expect(analysis).toMatchObject({ status: "occupied", label: "Occupé" });
  });

  it("ne fait pas d'un vide sanitaire une hypothèse favorable", () => {
    const analysis = buildOccupancyAnalysis({
      ...cleanSale,
      occupancy_status: "unknown",
      description: "Maison sur vide sanitaire, accès libre au jardin.",
    });
    expect(analysis).toMatchObject({
      status: "to_confirm",
      label: "À confirmer",
      confidenceLabel: "Occupation à confirmer dans les pièces",
    });
    expect(analysis.decisionImpact).not.toContain("Hypothèse favorable");
  });

  it("does not read the pipeline's own risk notes back as occupation evidence", () => {
    const analysis = buildOccupancyAnalysis({
      ...cleanSale,
      occupancy_status: "unknown",
      risk_notes: "Risques juridiques: bien loué, bail en cours, locataire en place.",
    });

    expect(analysis.status).toBe("to_confirm");
    expect(analysis.evidence.map((item) => item.source)).not.toContain("Notes de risques");
  });
});
