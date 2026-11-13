import Eye from "lucide-react/dist/esm/icons/eye.js";
import type { ReactNode } from "react";
import type { InformationAgentPreviewResponse } from "@/lib/information-agent/preview";

/** Début du motif de blocage rendu par l'aperçu quand l'adresse n'a aucune origine connue. */
const ORIGIN_UNKNOWN_BLOCKER = "Origine de l’adresse inconnue";

/**
 * Aperçu exact de l'e-mail avant l'envoi : expéditeur, destinataire, objet, origine de l'adresse (avec le lien
 * vers la page source), motifs bloquants, rendu HTML dans une iframe sans droits et version texte.
 */
export function AdminInformationAgentPreviewPanel({
  preview,
  current,
  loading,
  disabled,
  onShow,
  originField,
}: {
  preview: InformationAgentPreviewResponse | null;
  current: boolean;
  loading: boolean;
  disabled: boolean;
  onShow: () => void;
  /**
   * Champ « Page publique où figure l'adresse », placé juste sous les motifs de blocage : quand
   * l'aperçu signale une origine inconnue, il est mis en évidence à l'endroit où le message se lit.
   */
  originField?: ReactNode;
}) {
  const originRequired = Boolean(
    preview?.blockers.some((blocker) => blocker.startsWith(ORIGIN_UNKNOWN_BLOCKER)),
  );
  return (
    <section aria-label="Aperçu de l’e-mail" className="rounded-lg border bg-white p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">Aperçu de l’e-mail</h4>
        <button
          type="button"
          className="admin-button-secondary inline-flex items-center gap-2"
          disabled={disabled || loading}
          onClick={onShow}
        >
          <Eye className="size-4" aria-hidden="true" />
          {loading ? "Préparation…" : current ? "Actualiser l’aperçu" : "Afficher l’aperçu"}
        </button>
      </div>
      {!preview ? (
        <p className="mt-2 text-xs text-brand-navy/60">
          L’envoi n’est possible qu’après l’affichage de l’aperçu exact du message.
        </p>
      ) : null}
      {preview && !current ? (
        <p role="status" className="mt-2 text-xs text-amber-900">
          Le message a été modifié depuis cet aperçu : affichez-le de nouveau avant l’envoi.
        </p>
      ) : null}
      {preview?.blockers.length ? (
        <ul
          role="alert"
          className="mt-2 list-inside list-disc rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-800"
        >
          {preview.blockers.map((blocker) => (
            <li key={blocker}>{blocker}</li>
          ))}
        </ul>
      ) : null}
      {originField ? (
        <div
          data-origin-required={originRequired ? "true" : undefined}
          className={
            originRequired ? "mt-2 rounded-lg border-2 border-warning bg-warning-tint p-3" : "mt-2"
          }
        >
          {originRequired ? (
            <p className="mb-1 text-xs font-semibold text-warning">
              À renseigner avant l’envoi, puis actualisez l’aperçu.
            </p>
          ) : null}
          {originField}
        </div>
      ) : null}
      {preview ? (
        <>
          <dl className="mt-2 grid gap-1 text-xs text-brand-navy/75">
            <div>
              <dt className="inline font-medium">De : </dt>
              <dd className="inline">{preview.preview.from ?? "expéditeur à configurer"}</dd>
            </div>
            <div>
              <dt className="inline font-medium">À : </dt>
              <dd className="inline">{preview.preview.to}</dd>
            </div>
            <div>
              <dt className="inline font-medium">Objet : </dt>
              <dd className="inline">{preview.preview.subject}</dd>
            </div>
            <div>
              <dt className="inline font-medium">Origine de l’adresse : </dt>
              <dd className="inline">{preview.addressOrigin.text}</dd>
            </div>
            {preview.addressOrigin.courtRegistry ? (
              <div role="note" className="rounded-lg border border-sky-200 bg-sky-50 p-2">
                <dt className="inline font-medium">Greffe : </dt>
                <dd className="inline">
                  cette demande est adressée au greffe du tribunal (aucun avocat trouvé), pas à un
                  avocat.
                </dd>
              </div>
            ) : null}
            {preview.addressOrigin.automated ? (
              <div role="note" className="rounded-lg border border-amber-200 bg-amber-50 p-2">
                <dt className="inline font-medium">Adresse retrouvée automatiquement : </dt>
                <dd className="inline">
                  l’outil de recherche l’a lue sur une page publique, personne ne l’a encore
                  vérifiée.{" "}
                  {preview.addressOrigin.url ? (
                    <>
                      <a
                        href={preview.addressOrigin.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-medium underline"
                      >
                        Ouvrir la page source
                      </a>{" "}
                      et vérifier que l’adresse est bien celle de ce professionnel avant d’envoyer.
                    </>
                  ) : (
                    "Vérifiez l’adresse avant d’envoyer."
                  )}
                </dd>
              </div>
            ) : null}
          </dl>
          <iframe
            title="Aperçu de l’e-mail envoyé"
            srcDoc={preview.preview.html}
            sandbox=""
            className="mt-3 h-[640px] w-full rounded-lg border"
          />
          <details className="mt-2 text-xs text-brand-navy/75">
            <summary className="cursor-pointer font-medium">
              Version texte (envoyée avec le HTML, lue par certaines messageries)
            </summary>
            <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded-lg border bg-slate-50 p-3 font-sans">
              {preview.preview.text}
            </pre>
          </details>
          <p className="mt-2 text-xs text-brand-navy/55">
            Le jeton de l’adresse de réponse et le lien privé de dépôt sont attribués au moment de
            l’envoi ; tout le reste est identique au message qui partira.
          </p>
        </>
      ) : null}
    </section>
  );
}
