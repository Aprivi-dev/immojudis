import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

// Les constructeurs sont appelés pour de vrai ; la base et le réseau ne doivent jamais l'être.
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: vi.fn(), rpc: vi.fn(), auth: { admin: {} } },
}));

import { EMAIL_TEMPLATES } from "./registry";

/**
 * Neutralité de la migration des émetteurs vers `sendTrackedEmail` (module Emails, lot 3, 01/11/2026) : aucun
 * texte d'email ne change, le rendu reste identique octet pour octet. Les empreintes SHA-256 de l'objet, du HTML
 * et du texte de chaque variante d'aperçu ont été mesurées sur `origin/main` AVANT la migration, avec le code du
 * registre inchangé. Si un texte change volontairement (par exemple au lot 5), mettre ces empreintes à jour
 * dans le commit qui le change, avec sa justification : ce test n'est pas un instantané à régénérer sans
 * lire la différence.
 *
 * Mise à jour explicite du 02/11/2026 (emails « ne pas répondre ») : les empreintes de alert, sale_reminder,
 * weekly_digest, sale_result, trial_end, offer_opening et trial_ending ont changé, et SEULEMENT celles-là.
 * Comparées à `origin/main`, ces sept rendus ne diffèrent que par l'ajout de la phrase du pied (« Message
 * automatique, merci de ne pas y répondre. Pour nous écrire : contact@immojudis.com », HTML et texte) et
 * l'espace de 8 px sous le paragraphe qui la précède ; trial_ending reçoit en plus la cellule de pied qui
 * la porte. Les empreintes des huit autres gabarits (paiement échoué, résiliation, mise en relation, incident,
 * relecture des réponses, agent d'information) sont celles d'avant.
 *
 * Mise à jour explicite du 02/11/2026 (agent d'information, lot 1, ajout autorisé par le propriétaire) : les
 * empreintes de agent_request et agent_court_registry ont changé, et SEULEMENT celles-là. Les deux rendus ne
 * diffèrent de ceux d'avant que par UNE ligne sous la signature : le lien « Ne plus être contacté » (même
 * libellé et même adresse que celui du pied), en HTML (paragraphe discret) et en texte (« Ne plus être
 * contacté : <lien> »). Aucun autre texte ne change (vérifié par emails/information-request.test.tsx, qui garde
 * les textes juridiques mot pour mot).
 *
 * Mise à jour explicite du 06/11/2026 (revue marketing, n° 11, validée par le propriétaire) : l'empreinte de
 * trial_end a changé, et SEULEMENT celle-là. Seule la liste « Ce qui se ferme » diffère
 * (`LAUNCH_OFFER_END_NEEDS_ANALYSIS`, `launch-offer-end-lists.ts`) : le plafond et les alertes en tête, le PDF
 * cité une seule fois, formulations relues par juridique-rgpd. Avec l’ancienne liste, le rendu redonne
 * l’empreinte d’avant (vérifié).
 */
const BASELINE: Record<string, string> = {
  alert: "953d168d3a3d76c0d918d05717b2e62c72de9d91fc42a9219c060efa1dc1ddc1",
  sale_reminder: "89b4e771c33a8e3ba65dd0013af35fd14e355bcf0626bbd58ad5b14cf867a4ce",
  weekly_digest: "da2f3c451922e5683f5c531a57099c45b57c16becd516aa0b6defd7d3961e19e",
  sale_result: "7c64c7e5a5b08e1b888fefc460c6759d69c12c695d60bfba30f5d585e1d96d3f",
  trial_end: "c59fd7b65599c3e753cb0a957eb85033bc450b6be811646f71c3fa9c5eb30034",
  offer_opening: "33f6b0d764b9bb7b9e611de5250b6ac1cff11fd47139ace9da41154322d17f47",
  payment_failed: "a7cf5adb71220d3a7e3125032c3f5b22a82cbb7d713b29bb11b52c13352c4a40",
  trial_ending: "40d19feefa61fd75b6075103ed2ff7229ddf5a73988c9f8495ad619ff3fc9f13",
  cancellation: "2eb50b198be9349501148ada5fcaa716f796b516f3c1b001ec9d636d14220bb2",
  lawyer_referral: "57b2a20ad88d3316f9aabc5db9fafe799ab0fe22a733775963697aebcd72a108",
  operations_incident: "8dc2d6e71f97afacbf5670fb793ba904df1a01b06c26c660721eab3ee17e9311",
  replies_review_digest: "3aa56a8a32fda9dbdff6993248f105e11eed80ea4070185b8468dd6d0a39696d",
  agent_request: "cb2ab85a91f403b7d4733dab28dfdbecf91cc785003ca7fd4e2e8895d029d7ba",
  agent_court_registry: "7d736d062cd27e551d153d1cfd913de9b98281658327fad48c627c5ae5ab3bb5",
};

async function fingerprints(key: string): Promise<string[]> {
  const definition = EMAIL_TEMPLATES.find((template) => template.key === key);
  const variants = (await definition?.sample?.()) ?? [];
  return variants.map((variant) =>
    createHash("sha256")
      .update(JSON.stringify([variant.key, variant.subject, variant.html, variant.text]))
      .digest("hex"),
  );
}

describe("neutralité du rendu des emails", () => {
  it.each(Object.keys(BASELINE))("le gabarit %s rend les mêmes octets qu'avant", async (key) => {
    const actual = await fingerprints(key);
    expect(actual.length).toBeGreaterThan(0);
    expect(createHash("sha256").update(actual.join("|")).digest("hex")).toBe(BASELINE[key]);
  });
});
