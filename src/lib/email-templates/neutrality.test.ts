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
 */
const BASELINE: Record<string, string> = {
  alert: "02103b2ae97b91cb2f51e3fa221b48b801e3b38580f60ff1b6df5a8626c1390e",
  sale_reminder: "cdde2479b1813978a5d436e4a8da749f72420f7a2302f7c766c662aeead721eb",
  weekly_digest: "828f96b9afa722c97a70c326c118d6cb00e75cf5b34c1cbce7cca6c6ad18cb9e",
  sale_result: "f5337ec7611d4312f1de783fb44150d79e36089bbf0f7162d01df1d70fdbc2cb",
  trial_end: "4b5ff99fdf25c086426121af4720eff62d5454d7b531847311cb8238cb863cd7",
  offer_opening: "c1757d393e2253858c0d63134fad610e55c0e76ff4e5ca06224f436ada305f50",
  payment_failed: "a7cf5adb71220d3a7e3125032c3f5b22a82cbb7d713b29bb11b52c13352c4a40",
  trial_ending: "100b48368cae51488f5aceb88548f7aeabc6f1e06a8f6561f5d01a7674f30da3",
  cancellation: "2eb50b198be9349501148ada5fcaa716f796b516f3c1b001ec9d636d14220bb2",
  lawyer_referral: "57b2a20ad88d3316f9aabc5db9fafe799ab0fe22a733775963697aebcd72a108",
  operations_incident: "8dc2d6e71f97afacbf5670fb793ba904df1a01b06c26c660721eab3ee17e9311",
  replies_review_digest: "3aa56a8a32fda9dbdff6993248f105e11eed80ea4070185b8468dd6d0a39696d",
  agent_request: "0202c25c06bad99946a5fe07e04f3d0116b7d3b1b260a19c52236bb2369eb638",
  agent_court_registry: "a2dbd330e438cf93bd3a5c5dd85233b49c4351c7e381fc0fb79e035df8c8a20d",
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
