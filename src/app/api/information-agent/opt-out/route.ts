import "server-only";
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { errorDetailForLog } from "@/lib/api-errors";
import {
  normalizeOptOutEmail,
  parseOptOutEmail,
  verifyInformationAgentOptOutToken,
} from "@/lib/information-agent-opt-out";
import { enforceIpRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";

export const runtime = "nodejs";

/**
 * One-click objection from the footer of an information-agent email. Records a global opposition
 * for the address; the agent never contacts an opposed address again.
 */
export async function GET(request: Request) {
  try {
    await enforceIpRateLimit({
      request,
      bucketKey: "information-agent.opt-out",
      ...RATE_LIMIT_POLICIES.publicIp,
    });
    const params = new URL(request.url).searchParams;
    const email = parseOptOutEmail(params.get("e"));
    const secret = process.env.INFORMATION_AGENT_PORTAL_SECRET?.trim() ?? "";
    if (!email || !verifyInformationAgentOptOutToken(email, params.get("t") ?? "", secret)) {
      return page("Lien invalide", "Ce lien d’opposition est incomplet ou n’est plus valide.", 400);
    }
    const { error } = await supabaseAdmin.from("information_agent_contacts").upsert(
      {
        sale_id: null,
        scope_sale_id: null,
        email: normalizeOptOutEmail(email),
        opposition_status: "opposed",
        opposed_at: new Date().toISOString(),
      },
      { onConflict: "scope_sale_id,normalized_email" },
    );
    if (error) throw error;
    return page(
      "Opposition enregistrée",
      "Votre adresse ne sera plus contactée par Immojudis. Vous pouvez exercer vos autres droits depuis la page Confidentialité.",
      200,
    );
  } catch (error) {
    console.error(
      JSON.stringify({ scope: "information-agent.opt-out", error: errorDetailForLog(error) }),
    );
    return page(
      "Service indisponible",
      "Votre demande n’a pas pu être enregistrée. Répondez simplement à l’email reçu : l’opposition sera traitée par notre équipe.",
      503,
    );
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function page(title: string, message: string, status: number) {
  return new NextResponse(
    `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)} - Immojudis</title></head><body style="margin:0;background:#f6f4ef;color:#182033;font-family:Arial,sans-serif"><main style="min-height:100vh;display:grid;place-items:center;padding:24px"><section style="max-width:520px;background:#fff;border:1px solid #e8e1d4;border-radius:10px;padding:28px"><h1 style="margin:0 0 10px;font-size:24px">${escapeHtml(title)}</h1><p style="margin:0;color:#4b5563;line-height:1.55">${escapeHtml(message)}</p></section></main></body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    },
  );
}
