"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import FileText from "lucide-react/dist/esm/icons/file-text.js";
import Link2 from "lucide-react/dist/esm/icons/link-2.js";
import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import UploadCloud from "lucide-react/dist/esm/icons/upload-cloud.js";
import X from "lucide-react/dist/esm/icons/x.js";
import { legalValue, publicLegalPublisher } from "@/lib/legal-documents";
import { userMessage } from "@/lib/user-messages";
import { supabase } from "@/integrations/supabase/client";

const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_SUBMISSION_BYTES = 40 * 1024 * 1024;
const DEFAULT_MAX_PORTAL_BYTES = 480 * 1024 * 1024;
const DEFAULT_MAX_PORTAL_FILES = 12;
const MAX_FILES = 10;
const MAX_EXTERNAL_LINKS = 5;

const MIME_BY_EXTENSION: Record<string, string> = {
  ".pdf": "application/pdf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".txt": "text/plain",
};

const ACCEPTED_FILE_TYPES =
  ".pdf,.jpg,.jpeg,.png,.webp,.heic,.heif,.txt,application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif,text/plain";

type ContributionSession = {
  caseReference: string;
  subject: string;
  maxFileBytes: number;
  maxSubmissionBytes: number;
  maxPortalBytes: number;
  maxPortalFiles: number;
  optOutPath: string | null;
};

type SelectedFile = {
  file: File;
  mimeType: string;
  key: string;
};

type UploadResult = {
  bucket: string;
  path: string;
  token: string;
  ticket: string;
  remainingBytes: number;
  remainingFiles: number;
};

type PortalQuota = {
  remainingBytes: number;
  remainingFiles: number;
};

type UploadedFile = {
  key: string;
  path: string;
  filename: string;
  mimeType: string;
  size: number;
  ticket: string;
};

type ContributionState = "reading" | "loading" | "ready" | "invalid" | "error";

type FieldName =
  | "senderName"
  | "senderEmail"
  | "note"
  | "externalLinks"
  | "files"
  | "authorizedToTransmit";

const INCOMPLETE_LINK_MESSAGE =
  "Ce lien semble incomplet. Rouvrez-le depuis l’email que vous avez reçu, ou répondez simplement à cet email.";
const UNAVAILABLE_MESSAGE = "Service momentanément indisponible.";
const EXPIRED_LINK_HINT = "Répondez simplement à l’email que vous avez reçu pour nous en informer.";
const OPT_OUT_PATH_PREFIX = "/api/information-agent/opt-out?";
const ERROR_ALERT_ID = "contribution-error";

// The token lives in sessionStorage (scoped to the tab, never sent in a URL or logged) so that a
// reload or a back navigation does not lose it once it has been removed from the address bar.
function tokenStorageKey(missionId: string): string {
  return `immojudis:contribution-token:${missionId}`;
}

function readStoredToken(missionId: string): string | null {
  try {
    const value = window.sessionStorage.getItem(tokenStorageKey(missionId));
    return value && TOKEN_PATTERN.test(value) ? value : null;
  } catch {
    return null;
  }
}

function storeToken(missionId: string, token: string): void {
  try {
    window.sessionStorage.setItem(tokenStorageKey(missionId), token);
  } catch {
    // Storage can be unavailable (private mode, blocked cookies): the token stays in memory.
  }
}

function clearStoredToken(missionId: string): void {
  try {
    window.sessionStorage.removeItem(tokenStorageKey(missionId));
  } catch {
    // Nothing to clear.
  }
}

class ContributionHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ContributionHttpError";
  }
}

// The server answers 404 (unknown / expired link) or 410 (case closed) once it has checked the token.
function isLinkRejectedByServer(error: unknown): boolean {
  return error instanceof ContributionHttpError && (error.status === 404 || error.status === 410);
}

export function InformationAgentContributionForm({ missionId }: { missionId: string }) {
  const publisher = publicLegalPublisher();
  const initializedMission = useRef<string | null>(null);
  const requestVersion = useRef(0);
  const [state, setState] = useState<ContributionState>("reading");
  const [token, setToken] = useState<string | null>(null);
  const [session, setSession] = useState<ContributionSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [senderName, setSenderName] = useState("");
  const [senderEmail, setSenderEmail] = useState("");
  const [note, setNote] = useState("");
  const [linksText, setLinksText] = useState("");
  const [files, setFiles] = useState<SelectedFile[]>([]);
  const [authorizedToTransmit, setAuthorizedToTransmit] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submissionId, setSubmissionId] = useState<string | null>(null);
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [portalQuota, setPortalQuota] = useState<PortalQuota | null>(null);
  const [errorField, setErrorField] = useState<FieldName | null>(null);
  const [errorNonce, setErrorNonce] = useState(0);
  const errorRef = useRef<HTMLParagraphElement | null>(null);
  const successTitleRef = useRef<HTMLHeadingElement | null>(null);

  const loadSession = useCallback(
    (activeToken: string, version: number) => {
      setState("loading");
      setError(null);
      void postJson<ContributionSession>(
        `/api/information-agent/contributions/${encodeURIComponent(missionId)}`,
        { token: activeToken },
      )
        .then((data) => {
          if (version !== requestVersion.current) return;
          setSession({
            caseReference: data.caseReference,
            subject: data.subject,
            maxFileBytes: data.maxFileBytes || DEFAULT_MAX_FILE_BYTES,
            maxSubmissionBytes: data.maxSubmissionBytes || DEFAULT_MAX_SUBMISSION_BYTES,
            maxPortalBytes: data.maxPortalBytes || DEFAULT_MAX_PORTAL_BYTES,
            maxPortalFiles: data.maxPortalFiles || DEFAULT_MAX_PORTAL_FILES,
            optOutPath: safeOptOutPath(data.optOutPath),
          });
          setState("ready");
        })
        .catch((cause: unknown) => {
          if (version !== requestVersion.current) return;
          if (isLinkRejectedByServer(cause)) {
            // Expiry confirmed by the server: the stored token is useless, forget it.
            clearStoredToken(missionId);
            setToken(null);
            setState("invalid");
            setError(
              `${errorMessage(cause, "Ce lien de dépôt n’est plus valide.")} ${EXPIRED_LINK_HINT}`,
            );
            return;
          }
          setState("error");
          setError(UNAVAILABLE_MESSAGE);
        });
    },
    [missionId],
  );

  useEffect(() => {
    if (initializedMission.current === missionId) return;
    initializedMission.current = missionId;
    const version = ++requestVersion.current;
    const fragment = window.location.hash.slice(1);

    // The token is read from the address fragment, which is removed before any network request so
    // it cannot remain in browser history or referrers. A copy is kept in sessionStorage (this tab
    // only, see storeToken) so that a reload does not lose it; it is erased once the link is
    // rejected, the contribution is sent or the contributor leaves through the opposition link.
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${window.location.search}`,
    );

    setToken(null);
    setSession(null);
    setError(null);
    setStatus(null);
    setSubmitted(false);
    setSubmissionId(null);
    setUploadedFiles([]);
    setPortalQuota(null);
    setFiles([]);

    // A reload, a back navigation or a reopened tab no longer carries the fragment: fall back to
    // the token kept for this tab.
    const activeToken = TOKEN_PATTERN.test(fragment) ? fragment : readStoredToken(missionId);
    if (!activeToken) {
      setState("invalid");
      setError(INCOMPLETE_LINK_MESSAGE);
      return;
    }

    storeToken(missionId, activeToken);
    setToken(activeToken);
    loadSession(activeToken, version);
  }, [missionId, loadSession]);

  useEffect(() => {
    if (errorNonce === 0) return;
    const alert = errorRef.current;
    if (!alert) return;
    if (typeof alert.scrollIntoView === "function") alert.scrollIntoView({ block: "center" });
    alert.focus({ preventScroll: true });
  }, [errorNonce]);

  useEffect(() => {
    if (!submitted) return;
    window.scrollTo({ top: 0 });
    successTitleRef.current?.focus({ preventScroll: true });
  }, [submitted]);

  const retryLoad = () => {
    if (!token) return;
    loadSession(token, ++requestVersion.current);
  };

  // Reports a validation error next to a focus move to the alert, so that it is announced and
  // visible even though the submit button sits far below it.
  const fail = (message: string, field: FieldName | null = null) => {
    setError(message);
    setErrorField(field);
    setErrorNonce((value) => value + 1);
  };

  const resetSubmissionProgress = () => {
    setSubmissionId(null);
    setUploadedFiles([]);
  };

  const addFiles = (incoming: File[]) => {
    setError(null);
    const normalized = incoming.map((file) => ({
      file,
      mimeType: mimeTypeForFile(file),
      key: crypto.randomUUID(),
    }));
    const invalidName = normalized.find((item) => item.file.name.length > 180);
    if (invalidName) {
      fail(`Le nom du fichier ${invalidName.file.name} dépasse 180 caractères.`, "files");
      return;
    }
    const emptyFile = normalized.find((item) => item.file.size === 0);
    if (emptyFile) {
      fail(`Le fichier ${emptyFile.file.name} est vide.`, "files");
      return;
    }
    const invalidType = normalized.find((item) => !isAllowedMimeType(item.mimeType));
    if (invalidType) {
      fail(`Format non pris en charge : ${invalidType.file.name}.`, "files");
      return;
    }
    const tooLarge = normalized.find(
      (item) => item.file.size > (session?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES),
    );
    if (tooLarge) {
      fail(`Le fichier ${tooLarge.file.name} dépasse la limite de 20 Mo.`, "files");
      return;
    }
    if (files.length + normalized.length > MAX_FILES) {
      fail(`Vous pouvez joindre au maximum ${MAX_FILES} fichiers.`, "files");
      return;
    }
    const totalBytes = [...files, ...normalized].reduce((total, item) => total + item.file.size, 0);
    if (totalBytes > (session?.maxSubmissionBytes ?? DEFAULT_MAX_SUBMISSION_BYTES)) {
      fail("Le dépôt dépasse la limite totale de 40 Mo.", "files");
      return;
    }
    resetSubmissionProgress();
    setFiles((current) => [...current, ...normalized]);
  };

  const removeFile = (key: string) => {
    resetSubmissionProgress();
    setFiles((current) => current.filter((item) => item.key !== key));
    setError(null);
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!token || !session || submitted || submitting) return;

    const cleanName = senderName.trim();
    const cleanEmail = senderEmail.trim();
    const cleanNote = note.trim();
    const links = parseLinks(linksText);

    setError(null);
    setStatus(null);
    if (cleanName.length < 2) {
      fail("Indiquez votre nom ou votre cabinet.", "senderName");
      return;
    }
    if (!isEmail(cleanEmail)) {
      fail("Indiquez une adresse e-mail valide.", "senderEmail");
      return;
    }
    if (links.length > MAX_EXTERNAL_LINKS) {
      fail(`Ajoutez au maximum ${MAX_EXTERNAL_LINKS} liens, un par ligne.`, "externalLinks");
      return;
    }
    if (links.some((value) => !isHttpUrl(value))) {
      fail("Chaque lien doit commencer par http:// ou https://.", "externalLinks");
      return;
    }
    if (!cleanNote && !links.length && !files.length) {
      fail("Ajoutez une réponse, un lien ou au moins une pièce jointe.", "note");
      return;
    }
    if (!authorizedToTransmit) {
      fail(
        "Confirmez que vous êtes autorisé à transmettre ces informations.",
        "authorizedToTransmit",
      );
      return;
    }

    setSubmitting(true);
    try {
      const activeSubmissionId = submissionId ?? crypto.randomUUID();
      let completedUploads = uploadedFiles;
      if (!submissionId) setSubmissionId(activeSubmissionId);

      for (const [index, selected] of files.entries()) {
        if (completedUploads.some((uploaded) => uploaded.key === selected.key)) continue;
        setStatus(`Préparation de la pièce ${index + 1} sur ${files.length}…`);
        const prepared = await postJson<UploadResult>(
          `/api/information-agent/contributions/${encodeURIComponent(missionId)}/upload`,
          {
            token,
            filename: selected.file.name,
            mimeType: selected.mimeType,
            size: selected.file.size,
          },
        );
        setPortalQuota({
          remainingBytes: prepared.remainingBytes,
          remainingFiles: prepared.remainingFiles,
        });
        const { error: uploadError } = await supabase.storage
          .from(prepared.bucket)
          .uploadToSignedUrl(prepared.path, prepared.token, selected.file);
        if (uploadError) throw uploadError;
        const completedUpload: UploadedFile = {
          key: selected.key,
          path: prepared.path,
          filename: selected.file.name,
          mimeType: selected.mimeType,
          size: selected.file.size,
          ticket: prepared.ticket,
        };
        completedUploads = [...completedUploads, completedUpload];
        setUploadedFiles(completedUploads);
      }

      setStatus("Transmission de votre réponse…");
      await postJson<{ ok: true }>(
        `/api/information-agent/contributions/${encodeURIComponent(missionId)}/submit`,
        {
          token,
          submissionId: activeSubmissionId,
          senderName: cleanName,
          senderEmail: cleanEmail,
          note: cleanNote,
          externalLinks: links,
          authorizedToTransmit: true,
          files: completedUploads.map((file) => ({
            path: file.path,
            filename: file.filename,
            mimeType: file.mimeType,
            size: file.size,
            ticket: file.ticket,
          })),
        },
      );
      clearStoredToken(missionId);
      setSubmitted(true);
      setToken(null);
      setStatus("Votre contribution a bien été transmise.");
      setFiles([]);
      setSubmissionId(null);
      setUploadedFiles([]);
      setNote("");
      setLinksText("");
    } catch (cause: unknown) {
      if (isLinkRejectedByServer(cause)) clearStoredToken(missionId);
      fail(errorMessage(cause, "Impossible de transmettre votre contribution."));
      setStatus(null);
    } finally {
      setSubmitting(false);
    }
  };

  const invalidField = error ? errorField : null;
  const fieldA11y = (field: FieldName, hintId?: string) => ({
    "aria-invalid": invalidField === field ? true : undefined,
    "aria-describedby":
      [hintId, invalidField === field ? ERROR_ALERT_ID : null].filter(Boolean).join(" ") ||
      undefined,
  });

  return (
    <main
      id="contenu"
      className="liquid-page min-h-screen px-4 py-8 text-foreground sm:px-6 lg:py-12"
    >
      <div className="mx-auto max-w-3xl">
        <header className="glass-shell rounded-lg p-6 sm:p-9">
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-gold-text">
            <ShieldCheck className="size-4" aria-hidden="true" />
            Contribution sécurisée
          </div>
          <h1 className="mt-4 max-w-2xl font-display text-4xl leading-tight text-foreground sm:text-5xl">
            Transmettre les informations demandées
          </h1>
          <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted-foreground sm:text-base">
            Utilisez ce formulaire pour envoyer une réponse, des liens ou des pièces utiles au
            dossier. Une attestation de droit de transmission est demandée pour chaque dépôt.
          </p>
        </header>

        {state === "reading" || state === "loading" ? (
          <StatusCard icon={<LoaderCircle className="size-5 animate-spin" />}>
            Vérification du lien sécurisé…
          </StatusCard>
        ) : state === "invalid" || state === "error" ? (
          <StatusCard
            tone="error"
            role="alert"
            action={
              state === "error" && token ? (
                <button
                  type="button"
                  onClick={retryLoad}
                  className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-md bg-gold px-4 py-2 text-sm font-semibold text-brand-navy transition hover:bg-gold-soft"
                >
                  Réessayer
                </button>
              ) : null
            }
          >
            {error ?? "Ce lien de dépôt est indisponible."}
          </StatusCard>
        ) : session ? (
          <section
            className="glass-shell mt-6 rounded-lg p-6 sm:p-8"
            aria-labelledby="contribution-title"
          >
            <h2 id="contribution-title" className="sr-only">
              Contribution au dossier
            </h2>
            {submitted ? (
              <div className="rounded-lg border border-emerald-700/20 bg-emerald-50 p-5 text-emerald-950">
                <h2
                  ref={successTitleRef}
                  tabIndex={-1}
                  className="text-lg font-semibold outline-none"
                >
                  Contribution reçue
                </h2>
                <p role="status" aria-live="polite" className="mt-2 text-sm leading-relaxed">
                  {status ?? "Votre réponse a bien été transmise."} Vous pouvez fermer cette page.
                </p>
              </div>
            ) : (
              <>
                <div className="rounded-lg border border-border bg-white/70 p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                    Référence
                  </p>
                  <p className="mt-1 font-display text-2xl text-foreground">
                    {session.caseReference}
                  </p>
                  <p className="mt-2 text-sm text-muted-foreground">{session.subject}</p>
                </div>

                <form className="mt-7 space-y-6" onSubmit={submit} noValidate>
                  {error ? (
                    <p
                      ref={errorRef}
                      id={ERROR_ALERT_ID}
                      tabIndex={-1}
                      role="alert"
                      className="rounded-md border border-red-700/20 bg-red-50 p-3 text-sm text-red-900 outline-none focus-visible:ring-2 focus-visible:ring-red-700/40"
                    >
                      {error}
                    </p>
                  ) : null}
                  {status ? (
                    <p
                      role="status"
                      aria-live="polite"
                      className="rounded-md border border-border bg-background/70 p-3 text-sm text-foreground"
                    >
                      {status}
                    </p>
                  ) : null}

                  <div className="grid gap-5 sm:grid-cols-2">
                    <Field label="Nom ou cabinet" htmlFor="sender-name" required>
                      <input
                        id="sender-name"
                        name="senderName"
                        autoComplete="name"
                        required
                        {...fieldA11y("senderName")}
                        value={senderName}
                        onChange={(event) => {
                          resetSubmissionProgress();
                          setSenderName(event.target.value);
                        }}
                        className={inputClassName}
                      />
                    </Field>
                    <Field
                      label="Adresse e-mail"
                      htmlFor="sender-email"
                      required
                      hint="Indiquez l’adresse à laquelle vous souhaitez être recontacté. Nous la comparons à celle à laquelle nous avons écrit."
                    >
                      <input
                        id="sender-email"
                        name="senderEmail"
                        type="email"
                        autoComplete="email"
                        required
                        {...fieldA11y("senderEmail", "sender-email-hint")}
                        value={senderEmail}
                        onChange={(event) => {
                          resetSubmissionProgress();
                          setSenderEmail(event.target.value);
                        }}
                        className={inputClassName}
                      />
                    </Field>
                  </div>

                  <Field
                    label="Votre réponse"
                    htmlFor="contribution-note"
                    hint="Vous pouvez répondre uniquement par texte, sans fichier."
                  >
                    <textarea
                      id="contribution-note"
                      name="note"
                      rows={6}
                      {...fieldA11y("note", "contribution-note-hint")}
                      value={note}
                      onChange={(event) => {
                        resetSubmissionProgress();
                        setNote(event.target.value);
                      }}
                      className={`${inputClassName} resize-y`}
                      placeholder="Écrivez ici les informations que vous souhaitez transmettre…"
                    />
                  </Field>

                  <Field
                    label="Liens utiles"
                    htmlFor="external-links"
                    hint={`Un lien par ligne, ${MAX_EXTERNAL_LINKS} maximum. http:// et https:// uniquement.`}
                  >
                    <div className="relative">
                      <Link2
                        className="pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground"
                        aria-hidden="true"
                      />
                      <textarea
                        id="external-links"
                        name="externalLinks"
                        rows={3}
                        {...fieldA11y("externalLinks", "external-links-hint")}
                        value={linksText}
                        onChange={(event) => {
                          resetSubmissionProgress();
                          setLinksText(event.target.value);
                        }}
                        className={`${inputClassName} resize-y pl-9`}
                        placeholder="https://…"
                      />
                    </div>
                  </Field>

                  <div>
                    <label
                      className="block text-sm font-semibold text-foreground"
                      htmlFor="contribution-files"
                    >
                      Pièces jointes
                    </label>
                    <p
                      id="files-help"
                      className="mt-1 text-xs leading-relaxed text-muted-foreground"
                    >
                      PDF, JPEG, PNG, WebP, HEIC, HEIF ou TXT · 20 Mo par fichier · 40 Mo au total.
                    </p>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      Ce dossier accepte jusqu’à {session.maxPortalFiles} dépôts, dans une capacité
                      réservée de {formatBytes(session.maxPortalBytes)}. Chaque préparation réserve
                      40 Mo, même pour une pièce plus petite.
                    </p>
                    {portalQuota ? (
                      <p
                        id="files-quota"
                        role="status"
                        className="mt-1 text-xs leading-relaxed text-muted-foreground"
                      >
                        Capacité restante après cette préparation :{" "}
                        {formatBytes(portalQuota.remainingBytes)} et {portalQuota.remainingFiles}{" "}
                        {portalQuota.remainingFiles > 1 ? "fichiers" : "fichier"}.
                      </p>
                    ) : null}
                    <label
                      htmlFor="contribution-files"
                      className="mt-3 flex min-h-28 cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-gold/50 bg-cream/40 px-4 py-5 text-center transition hover:border-gold hover:bg-cream has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-gold has-[:focus-visible]:ring-offset-2"
                    >
                      <UploadCloud className="size-6 text-gold-text" aria-hidden="true" />
                      <span className="mt-2 text-sm font-semibold text-foreground">
                        Choisir des fichiers
                      </span>
                      <span className="mt-1 text-xs text-muted-foreground">
                        Ils sont stockés dans un espace privé, accessible à l’équipe Immojudis.
                      </span>
                      <input
                        id="contribution-files"
                        name="files"
                        type="file"
                        multiple
                        accept={ACCEPTED_FILE_TYPES}
                        {...fieldA11y("files", "files-help")}
                        className="sr-only"
                        onChange={(event) => {
                          addFiles(Array.from(event.currentTarget.files ?? []));
                          event.currentTarget.value = "";
                        }}
                      />
                    </label>
                    {files.length ? (
                      <ul
                        className="mt-3 divide-y divide-border rounded-lg border border-border bg-white/60"
                        aria-label="Fichiers sélectionnés"
                      >
                        {files.map((selected) => (
                          <li
                            key={selected.key}
                            className="flex items-center gap-3 px-3 py-3 text-sm"
                          >
                            <FileText
                              className="size-4 shrink-0 text-gold-text"
                              aria-hidden="true"
                            />
                            <span className="min-w-0 flex-1 truncate text-foreground">
                              {selected.file.name}
                            </span>
                            <span className="shrink-0 text-xs text-muted-foreground">
                              {formatBytes(selected.file.size)}
                            </span>
                            <button
                              type="button"
                              onClick={() => removeFile(selected.key)}
                              className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                              aria-label={`Retirer ${selected.file.name}`}
                            >
                              <X className="size-4" aria-hidden="true" />
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>

                  <label
                    className="flex items-start gap-3 rounded-lg border border-border bg-background/60 p-4 text-sm text-foreground"
                    htmlFor="authorized-to-transmit"
                  >
                    <input
                      id="authorized-to-transmit"
                      name="authorizedToTransmit"
                      type="checkbox"
                      {...fieldA11y("authorizedToTransmit")}
                      checked={authorizedToTransmit}
                      onChange={(event) => {
                        resetSubmissionProgress();
                        setAuthorizedToTransmit(event.target.checked);
                      }}
                      className="mt-1 size-4 accent-gold"
                    />
                    <span>
                      J’atteste être autorisé à transmettre ces informations et pièces à Immojudis.
                      <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                        Cette attestation concerne le droit de transmission au dossier. Elle ne vaut
                        pas autorisation de diffusion publique de la pièce.
                      </span>
                    </span>
                  </label>

                  <p
                    id="contribution-privacy-notice"
                    className="rounded-lg border border-border bg-background/60 p-4 text-sm leading-relaxed text-foreground"
                  >
                    Immojudis ({legalValue(publisher.entityName)}) utilise ces informations pour
                    répondre à votre demande et vérifier les informations d’une vente, sur la base
                    de son intérêt légitime. Elles sont lues par l’équipe, avec l’aide d’un outil
                    d’IA (prestataire établi aux États-Unis), puis vérifiées avant toute utilisation
                    sur une fiche. Conservation : 12 à 24 mois. Vous pouvez vous opposer, demander
                    l’accès, la rectification ou l’effacement et saisir la CNIL :{" "}
                    <Link
                      href="/privacy"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-semibold underline underline-offset-2 hover:text-gold-text"
                    >
                      Politique de confidentialité
                    </Link>
                    .
                  </p>

                  <button
                    type="submit"
                    className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md bg-gold px-5 py-3 text-sm font-semibold text-brand-navy transition hover:bg-gold-soft hover:text-brand-navy disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={submitting}
                  >
                    {submitting ? (
                      <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                    ) : null}
                    {submitting ? "Transmission en cours…" : "Transmettre ma contribution"}
                  </button>
                </form>
              </>
            )}
          </section>
        ) : null}

        <p className="mx-auto mt-5 max-w-2xl text-center text-xs leading-relaxed text-muted-foreground">
          Les pièces sont stockées dans un espace privé, accessible à l’équipe Immojudis, et restent
          soumises à une revue avant toute utilisation sur une fiche.
        </p>
        <nav
          aria-label="Vie privée"
          className="mx-auto mt-2 flex max-w-2xl flex-wrap items-center justify-center gap-x-2 text-xs text-muted-foreground"
        >
          <Link
            href="/privacy"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-11 items-center px-2 underline underline-offset-2 hover:text-foreground"
          >
            Politique de confidentialité
          </Link>
          {session?.optOutPath ? (
            <>
              <span aria-hidden="true">·</span>
              {/* A button rather than a link: the signed opposition address stays in memory and is
                  never written into the markup as a persistent href. */}
              <button
                type="button"
                onClick={() => {
                  // The page is left for the opposition one: forget the token kept for this tab.
                  clearStoredToken(missionId);
                  window.location.assign(session.optOutPath ?? "");
                }}
                className="inline-flex min-h-11 items-center px-2 underline underline-offset-2 hover:text-foreground"
              >
                Ne plus être contacté par Immojudis
              </button>
            </>
          ) : (
            <>
              <span aria-hidden="true">·</span>
              {/* No signed opposition link (expired or invalid link): the published contact
                  address takes the opposition and the exercise of the rights. */}
              <span
                id="contribution-rights-contact"
                className="inline-flex min-h-11 items-center px-2"
              >
                Pour vous opposer ou exercer vos droits :{" "}
                {publisher.contactEmail ? (
                  <a
                    href={`mailto:${publisher.contactEmail}`}
                    className="ml-1 underline underline-offset-2 hover:text-foreground"
                  >
                    {publisher.contactEmail}
                  </a>
                ) : (
                  <span className="ml-1">{legalValue(publisher.contactEmail)}</span>
                )}
              </span>
            </>
          )}
        </nav>
      </div>
    </main>
  );
}

function Field({
  label,
  htmlFor,
  required = false,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="block text-sm font-semibold text-foreground">
        {label}{" "}
        {required ? (
          <span aria-hidden="true" className="text-gold-text">
            *
          </span>
        ) : null}
      </label>
      {hint ? (
        <p id={`${htmlFor}-hint`} className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {hint}
        </p>
      ) : null}
      <div className="mt-2">{children}</div>
    </div>
  );
}

function StatusCard({
  children,
  tone = "neutral",
  role,
  icon,
  action,
}: {
  children: React.ReactNode;
  tone?: "neutral" | "error";
  role?: "alert" | "status";
  icon?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div
      className={`glass-shell mt-6 flex items-center gap-3 rounded-lg p-5 text-sm ${
        tone === "error" ? "border-red-700/20 bg-red-50 text-red-900" : "text-foreground"
      }`}
      role={role}
      aria-live={role === "status" ? "polite" : undefined}
    >
      {icon}
      <span className="min-w-0 flex-1">{children}</span>
      {action}
    </div>
  );
}

const inputClassName =
  "block min-h-11 w-full rounded-md border border-input bg-white/75 px-3 py-2.5 text-sm text-foreground outline-none transition placeholder:text-muted-foreground focus:border-gold focus:ring-2 focus:ring-gold/20";

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const raw = await response.text();
  let payload: unknown;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && !Array.isArray(payload) && "error" in payload
        ? (payload as { error?: unknown }).error
        : null;
    throw new ContributionHttpError(
      typeof message === "string" ? message : "La demande n’a pas abouti.",
      response.status,
    );
  }
  return payload as T;
}

// Only same-origin opposition paths are followed; anything else coming back is ignored.
function safeOptOutPath(value: unknown): string | null {
  return typeof value === "string" && value.startsWith(OPT_OUT_PATH_PREFIX) ? value : null;
}

function mimeTypeForFile(file: File): string {
  const declared = file.type.trim().toLowerCase();
  if (isAllowedMimeType(declared)) return declared;
  const extension = `.${file.name.split(".").at(-1)?.toLowerCase() ?? ""}`;
  return MIME_BY_EXTENSION[extension] ?? declared;
}

function isAllowedMimeType(value: string): boolean {
  return new Set(Object.values(MIME_BY_EXTENSION)).has(value);
}

function parseLinks(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} Mo`;
  return `${Math.max(1, Math.round(value / 1024))} Ko`;
}

function errorMessage(error: unknown, fallback: string): string {
  return userMessage(error, fallback);
}
