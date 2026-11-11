import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * LANCEMENT MANUEL de la mesure à blanc des destinataires de l'agent d'information (`dry-run.ts`).
 *
 * Ignoré par `npm test` : il ne s'exécute que si `INFORMATION_AGENT_DRY_RUN_SALE_IDS_FILE` désigne un
 * fichier d'identifiants de ventes (un UUID par ligne). Il lit la base désignée par `SUPABASE_URL` et
 * `SUPABASE_SERVICE_ROLE_KEY` (lecture seule : aucune écriture, aucun envoi) et n'affiche QUE des
 * comptages : ni adresse, ni nom, ni identifiant de vente. La personne qui détient la clé de service agit
 * ici en administrateur.
 *
 *   INFORMATION_AGENT_DRY_RUN_SALE_IDS_FILE=/chemin/ventes.txt \
 *   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
 *   npx vitest run src/lib/information-agent-dry-run.manual.test.ts
 */
const idsFile = process.env.INFORMATION_AGENT_DRY_RUN_SALE_IDS_FILE?.trim();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe.skipIf(!idsFile)("mesure à blanc des destinataires (lancement manuel)", () => {
  it("affiche les comptages, et rien d'autre", { timeout: 600_000 }, async () => {
    const lines = readFileSync(idsFile as string, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const invalid = lines.filter((line) => !UUID.test(line));
    // Le nombre seulement : une ligne mal formée peut contenir autre chose qu'un identifiant.
    expect(invalid.length, "lignes qui ne sont pas des identifiants de vente").toBe(0);
    const saleIds = [...new Set(lines)];

    const { measureInformationAgentRecipients } = await import("@/lib/information-agent/dry-run");
    const report = await measureInformationAgentRecipients({
      auth: { isAdmin: true } as never,
      saleIds,
    });
    console.info(JSON.stringify(report.summary, null, 2));

    expect(report.summary.total).toBe(saleIds.length);
    expect(JSON.stringify(report.summary)).not.toContain("@");
  });
});
