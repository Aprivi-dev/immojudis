"use client";

import { useEffect, useRef, useState } from "react";
import FileText from "lucide-react/dist/esm/icons/file-text.js";
import Link2 from "lucide-react/dist/esm/icons/link-2.js";
import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import UploadCloud from "lucide-react/dist/esm/icons/upload-cloud.js";
import X from "lucide-react/dist/esm/icons/x.js";
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

export function InformationAgentContributionForm({ missionId }: { missionId: string }) {
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

  useEffect(() => {
    if (initializedMission.current === missionId) return;
    initializedMission.current = missionId;
    const version = ++requestVersion.current;
    const fragment = window.location.hash.slice(1);

    // The token is intentionally read from memory only, then removed before
    // any network request so it cannot remain in browser history or referrers.
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

    if (!TOKEN_PATTERN.test(fragment)) {
      setState("invalid");
      setError("Ce lien de dépôt est invalide ou incomplet.");
      return;
    }

    setToken(fragment);
    setState("loading");
    void postJson<ContributionSession>(
      `/api/information-agent/contributions/${encodeURIComponent(missionId)}`,
      { token: fragment },
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
        });
        setState("ready");
      })
      .catch((cause: unknown) => {
        if (version !== requestVersion.current) return;
        setState("error");
        setError(errorMessage(cause, "Ce lien est invalide ou temporairement indisponible."));
      });
  }, [missionId]);

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
      setError(`Le nom du fichier ${invalidName.file.name} dépasse 180 caractères.`);
      return;
    }
    const emptyFile = normalized.find((item) => item.file.size === 0);
    if (emptyFile) {
      setError(`Le fichier ${emptyFile.file.name} est vide.`);
      return;
    }
    const invalidType = normalized.find((item) => !isAllowedMimeType(item.mimeType));
    if (invalidType) {
      setError(`Format non pris en charge : ${invalidType.file.name}.`);
      return;
    }
    const tooLarge = normalized.find(
      (item) => item.file.size > (session?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES),
    );
    if (tooLarge) {
      setError(`Le fichier ${tooLarge.file.name} dépasse la limite de 20 Mo.`);
      return;
    }
    if (files.length + normalized.length > MAX_FILES) {
      setError(`Vous pouvez joindre au maximum ${MAX_FILES} fichiers.`);
      return;
    }
    const totalBytes = [...files, ...normalized].reduce((total, item) => total + item.file.size, 0);
    if (totalBytes > (session?.maxSubmissionBytes ?? DEFAULT_MAX_SUBMISSION_BYTES)) {
      setError("Le dépôt dépasse la limite totale de 40 Mo.");
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
      setError("Indiquez votre nom ou votre cabinet.");
      return;
    }
    if (!isEmail(cleanEmail)) {
      setError("Indiquez une adresse e-mail valide.");
      return;
    }
    if (links.length > MAX_EXTERNAL_LINKS) {
      setError(`Ajoutez au maximum ${MAX_EXTERNAL_LINKS} liens, un par ligne.`);
      return;
    }
    if (links.some((value) => !isHttpUrl(value))) {
      setError("Chaque lien doit commencer par http:// ou https://.");
      return;
    }
    if (!cleanNote && !links.length && !files.length) {
      setError("Ajoutez une réponse, un lien ou au moins une pièce jointe.");
      return;
    }
    if (!authorizedToTransmit) {
      setError("Confirmez que vous êtes autorisé à transmettre ces informations.");
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
      setSubmitted(true);
      setToken(null);
      setStatus("Votre contribution a bien été transmise.");
      setFiles([]);
      setSubmissionId(null);
      setUploadedFiles([]);
      setNote("");
      setLinksText("");
    } catch (cause: unknown) {
      setError(errorMessage(cause, "Impossible de transmettre votre contribution."));
      setStatus(null);
    } finally {
      setSubmitting(false);
    }
  };

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
          <StatusCard tone="error" role="alert">
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
                <h2 className="text-lg font-semibold">Contribution reçue</h2>
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
                      role="alert"
                      className="rounded-md border border-red-700/20 bg-red-50 p-3 text-sm text-red-900"
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
                      hint="Cette adresse est déclarative : elle identifie la réponse et peut être comparée au contact attendu."
                    >
                      <input
                        id="sender-email"
                        name="senderEmail"
                        type="email"
                        autoComplete="email"
                        required
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
                      className="mt-3 flex min-h-28 cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-gold/50 bg-cream/40 px-4 py-5 text-center transition hover:border-gold hover:bg-cream"
                    >
                      <UploadCloud className="size-6 text-gold-text" aria-hidden="true" />
                      <span className="mt-2 text-sm font-semibold text-foreground">
                        Choisir des fichiers
                      </span>
                      <span className="mt-1 text-xs text-muted-foreground">
                        Ils seront déposés dans un espace privé.
                      </span>
                    </label>
                    <input
                      id="contribution-files"
                      name="files"
                      type="file"
                      multiple
                      accept={ACCEPTED_FILE_TYPES}
                      aria-describedby="files-help"
                      className="sr-only"
                      onChange={(event) => {
                        addFiles(Array.from(event.currentTarget.files ?? []));
                        event.currentTarget.value = "";
                      }}
                    />
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
                              className="inline-flex min-h-9 min-w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
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
          Les pièces sont reçues dans un espace privé et restent soumises à une revue avant toute
          utilisation sur une fiche.
        </p>
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
      {hint ? <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{hint}</p> : null}
      <div className="mt-2">{children}</div>
    </div>
  );
}

function StatusCard({
  children,
  tone = "neutral",
  role,
  icon,
}: {
  children: React.ReactNode;
  tone?: "neutral" | "error";
  role?: "alert" | "status";
  icon?: React.ReactNode;
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
      <span>{children}</span>
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
    throw new Error(typeof message === "string" ? message : "La demande n’a pas abouti.");
  }
  return payload as T;
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
