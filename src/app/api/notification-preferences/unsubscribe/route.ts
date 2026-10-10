import { NextResponse } from "next/server";
import { errorDetailForLog } from "@/lib/api-errors";
import {
  deactivateAlertForUser,
  revokeEmailAlertConsent,
  unsubscribeEmailAlertsByNotificationId,
} from "@/lib/email-alerts";
import { verifyUnsubscribeToken } from "@/lib/email-unsubscribe-token";
import { escapeHtml } from "@/lib/guards";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A GET only shows a confirmation page: mail scanners and link previews open
 * links, and must never unsubscribe anyone. The change is made by the POST
 * behind the button, or by the one-click POST of mail clients (RFC 8058).
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const legacyNotificationId = url.searchParams.get("notificationId");

  if (token) {
    const claims = verifyUnsubscribeToken(token);
    if (!claims) {
      return htmlResponse(
        "Lien expiré",
        "Ce lien de désinscription n'est plus valide. Ouvrez la page Mes alertes pour gérer vos emails.",
        400,
        { href: "/alertes", label: "Gérer mes alertes" },
      );
    }
    const scopeLabel =
      claims.scope.kind === "alert"
        ? "Voulez-vous désactiver cette alerte ?"
        : "Voulez-vous ne plus recevoir d'alertes par email ?";
    return htmlResponse("Confirmer la désinscription", scopeLabel, 200, null, {
      field: "token",
      value: token,
      button:
        claims.scope.kind === "alert" ? "Désactiver cette alerte" : "Me désinscrire des emails",
    });
  }

  if (legacyNotificationId && UUID_PATTERN.test(legacyNotificationId)) {
    return htmlResponse(
      "Confirmer la désinscription",
      "Voulez-vous ne plus recevoir d'alertes par email ?",
      200,
      null,
      { field: "notificationId", value: legacyNotificationId, button: "Me désinscrire des emails" },
    );
  }

  return htmlResponse("Lien incomplet", "Le lien de désinscription est incomplet.", 400);
}

export async function POST(request: Request) {
  const url = new URL(request.url);
  let token = url.searchParams.get("token");
  let legacyNotificationId = url.searchParams.get("notificationId");

  // The mail client's one-click request carries "List-Unsubscribe=One-Click"
  // in a form body; the confirmation page posts the token as a form field.
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const body = new URLSearchParams(await request.text());
    token = token ?? body.get("token");
    legacyNotificationId = legacyNotificationId ?? body.get("notificationId");
  }

  try {
    if (token) {
      const claims = verifyUnsubscribeToken(token);
      if (!claims) {
        return htmlResponse(
          "Lien expiré",
          "Ce lien de désinscription n'est plus valide. Ouvrez la page Mes alertes pour gérer vos emails.",
          400,
          { href: "/alertes", label: "Gérer mes alertes" },
        );
      }
      if (claims.scope.kind === "alert") {
        await deactivateAlertForUser({ userId: claims.userId, alertId: claims.scope.alertId });
        return htmlResponse(
          "Alerte désactivée",
          "Cette alerte est désactivée. Vos autres alertes continuent de fonctionner.",
          200,
          { href: "/alertes", label: "Gérer mes alertes" },
        );
      }
      await revokeEmailAlertConsent({ userId: claims.userId });
    } else if (legacyNotificationId && UUID_PATTERN.test(legacyNotificationId)) {
      await unsubscribeEmailAlertsByNotificationId({ notificationId: legacyNotificationId });
    } else {
      return htmlResponse("Lien incomplet", "Le lien de désinscription est incomplet.", 400);
    }
    return htmlResponse(
      "Désinscription confirmée",
      "Vous ne recevrez plus d'alertes email ImmoJudis. Les notifications dans l'application restent disponibles.",
      200,
      { href: "/alertes", label: "Gérer mes alertes" },
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        scope: "notification-preferences.unsubscribe",
        error: errorDetailForLog(error),
      }),
    );
    return htmlResponse(
      "Désinscription impossible",
      "La désinscription n'a pas pu être confirmée. Réessayez ou gérez vos emails depuis votre compte.",
      500,
      { href: "/alertes", label: "Gérer mes alertes" },
    );
  }
}

function htmlResponse(
  title: string,
  message: string,
  status: number,
  link: { href: string; label: string } | null = null,
  form: { field: "token" | "notificationId"; value: string; button: string } | null = null,
) {
  return new NextResponse(
    `<!doctype html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>${escapeHtml(title)} - ImmoJudis</title>
  </head>
  <body style="margin:0;background:#f6f4ef;color:#182033;font-family:Arial,sans-serif;">
    <main style="min-height:100vh;display:grid;place-items:center;padding:24px;">
      <section style="max-width:520px;background:#fff;border:1px solid #e8e1d4;border-radius:10px;padding:28px;">
        <p style="margin:0 0 10px;color:#7a5f1f;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;">ImmoJudis</p>
        <h1 style="margin:0 0 10px;font-size:24px;line-height:1.25;">${escapeHtml(title)}</h1>
        <p style="margin:0 0 18px;color:#4b5563;line-height:1.55;">${escapeHtml(message)}</p>
        ${
          form
            ? `<form method="post" action="/api/notification-preferences/unsubscribe">
          <input type="hidden" name="${form.field}" value="${escapeHtml(form.value)}" />
          <button type="submit" style="background:#182033;color:#fff;border:0;border-radius:8px;padding:12px 16px;font-weight:700;font-size:15px;cursor:pointer;">${escapeHtml(form.button)}</button>
        </form>`
            : ""
        }
        ${link ? `<p style="margin:0;"><a href="${escapeHtml(link.href)}" style="color:#182033;font-weight:700;">${escapeHtml(link.label)}</a></p>` : ""}
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
