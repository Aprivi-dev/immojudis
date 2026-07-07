import { NextResponse } from "next/server";
import { unsubscribeEmailAlertsByNotificationId } from "@/lib/email-alerts";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const notificationId = new URL(request.url).searchParams.get("notificationId");

  if (!notificationId) {
    return htmlResponse("Lien incomplet", "Le lien de désinscription est incomplet.", 400);
  }

  try {
    await unsubscribeEmailAlertsByNotificationId({ notificationId });
    return htmlResponse(
      "Désinscription confirmée",
      "Vous ne recevrez plus d'alertes email ImmoJudis. Les notifications dans l'application restent disponibles.",
      200,
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "La désinscription n'a pas pu être confirmée.";
    return htmlResponse("Désinscription impossible", message, 400);
  }
}

function htmlResponse(title: string, message: string, status: number) {
  return new NextResponse(
    `<!doctype html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)} - ImmoJudis</title>
  </head>
  <body style="margin:0;background:#f6f4ef;color:#182033;font-family:Arial,sans-serif;">
    <main style="min-height:100vh;display:grid;place-items:center;padding:24px;">
      <section style="max-width:520px;background:#fff;border:1px solid #e8e1d4;border-radius:10px;padding:28px;">
        <p style="margin:0 0 10px;color:#9b7a2f;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;">ImmoJudis</p>
        <h1 style="margin:0 0 10px;font-size:24px;line-height:1.25;">${escapeHtml(title)}</h1>
        <p style="margin:0;color:#4b5563;line-height:1.55;">${escapeHtml(message)}</p>
      </section>
    </main>
  </body>
</html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    if (char === "&") return "&amp;";
    if (char === "<") return "&lt;";
    if (char === ">") return "&gt;";
    if (char === '"') return "&quot;";
    return "&#39;";
  });
}
