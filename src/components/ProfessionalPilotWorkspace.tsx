"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { fetchSaleWorkspace, saveProfessionalPilotDossier } from "@/lib/client-api";
import { safeDocumentUrl } from "@/lib/documents";
import { formatPrice } from "@/lib/format";
import {
  buildPilotPacket,
  emptyPilotDraft,
  pilotDraftSchema,
  pilotEconomics,
  pilotReadiness,
  type PilotDefinition,
  type PilotDraft,
} from "@/lib/professional-pilots";
import { collectSaleDocuments } from "@/lib/sale-documents";
import { saleDisplayTitle } from "@/lib/sale-title";
import { isUuid } from "@/lib/sale-workspace-shared";
import type { AuctionSale } from "@/lib/types";

type AmountField =
  | "priceEur"
  | "acquisitionCostsEur"
  | "worksEur"
  | "carryingCostsEur"
  | "exitValueEur"
  | "financingEur"
  | "targetProfitEur";

const AMOUNT_FIELDS: Array<{ key: AmountField; label: string }> = [
  { key: "priceEur", label: "Prix envisagé" },
  { key: "acquisitionCostsEur", label: "Frais d'acquisition" },
  { key: "worksEur", label: "Travaux" },
  { key: "carryingCostsEur", label: "Portage et autres frais" },
  { key: "exitValueEur", label: "Valeur de sortie envisagée" },
  { key: "financingEur", label: "Financement mobilisable" },
  { key: "targetProfitEur", label: "Profit cible" },
];

export function ProfessionalPilotWorkspace({
  sale,
  definition,
  publicDemo = false,
}: {
  sale: AuctionSale;
  definition: PilotDefinition;
  publicDemo?: boolean;
}) {
  const { user, loading: authLoading } = useAuth();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<PilotDraft>(() => emptyPilotDraft(definition.kind));
  const [hydratedKey, setHydratedKey] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const storageKey = `immojudis:professional-pilot:v1:${user?.id ?? "guest"}:${sale.id}`;
  const activeStorageKey = useRef(storageKey);
  const hydrated = hydratedKey === storageKey;
  const canSync = !publicDemo && !authLoading && Boolean(user) && isUuid(sale.id);
  const workspaceQuery = useQuery({
    queryKey: ["professional-pilot-workspace", user?.id ?? null, sale.id],
    queryFn: () => fetchSaleWorkspace({ saleId: sale.id }),
    enabled: canSync,
    staleTime: 30_000,
  });
  const documents = useMemo(() => collectSaleDocuments(sale), [sale]);
  const workspace = workspaceQuery.data?.workspace;
  const remoteDraft = workspace?.private_notes.professionalDossier;
  const editable = hydrated && !saving && (!canSync || !workspaceQuery.isPending);
  const economics = pilotEconomics(draft);
  const readiness = pilotReadiness(definition, draft);
  const sourceChanged = Boolean(
    sale.updated_at && draft.updatedAt && Date.parse(sale.updated_at) > Date.parse(draft.updatedAt),
  );

  useEffect(() => {
    activeStorageKey.current = storageKey;
  }, [storageKey]);

  useEffect(() => {
    if (authLoading) return;
    let saved: string | null = null;
    try {
      saved = window.localStorage.getItem(storageKey);
    } catch {
      // Browsers may disable local storage; server sync can still work.
    }
    let next = emptyPilotDraft(definition.kind);
    if (saved) {
      try {
        const parsed = pilotDraftSchema.safeParse(JSON.parse(saved));
        if (parsed.success && parsed.data.kind === definition.kind) next = parsed.data;
      } catch {
        // A damaged local draft does not prevent opening the sale.
      }
    }
    setDraft(next);
    setHydratedKey(storageKey);
    setSaveMessage("");
    setConflict(false);
    setSaving(false);
  }, [authLoading, definition.kind, storageKey]);

  useEffect(() => {
    if (!canSync || !hydrated || !workspaceQuery.isSuccess) return;
    const version = workspace?.updated_at ?? null;
    if (!draft.updatedAt) {
      if (remoteDraft?.kind === definition.kind) {
        setDraft({ ...remoteDraft, workspaceRevision: version });
      } else if (draft.workspaceRevision !== version) {
        setDraft({ ...draft, workspaceRevision: version });
      }
      setConflict(false);
      return;
    }
    if (draft.workspaceRevision === version) {
      setConflict(false);
      return;
    }
    if (!remoteDraft) {
      setDraft({ ...draft, workspaceRevision: version });
      setConflict(false);
      return;
    }
    const sameRemote =
      remoteDraft?.kind === definition.kind &&
      JSON.stringify({ ...remoteDraft, workspaceRevision: null }) ===
        JSON.stringify({ ...draft, workspaceRevision: null });
    if (sameRemote) {
      setDraft({ ...draft, workspaceRevision: version });
      setConflict(false);
      return;
    }
    setConflict(true);
  }, [
    canSync,
    definition.kind,
    draft,
    hydrated,
    remoteDraft,
    workspace?.updated_at,
    workspaceQuery.isSuccess,
  ]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(draft));
    } catch {
      // Export and server sync remain available.
    }
  }, [draft, hydrated, storageKey]);

  const updateDraft = (patch: Partial<PilotDraft>) => {
    setDraft((current) => ({ ...current, ...patch, updatedAt: new Date().toISOString() }));
    setSaveMessage("");
  };

  const save = async () => {
    if (!canSync) {
      setSaveMessage(
        "Brouillon conservé sur cet appareil. Connectez-vous avec l'accès Analyse pour le retrouver ailleurs.",
      );
      return;
    }
    if (!workspaceQuery.isSuccess || conflict) {
      setSaveMessage(
        conflict
          ? "Le dossier a changé sur votre compte. Exportez votre brouillon puis chargez la version du compte."
          : "Synchronisation indisponible. Votre brouillon reste sur cet appareil.",
      );
      return;
    }
    const parsed = pilotDraftSchema.safeParse(draft);
    if (!parsed.success) {
      setSaveMessage("Vérifiez les montants et les textes saisis avant d'enregistrer.");
      return;
    }
    setSaving(true);
    const savingStorageKey = storageKey;
    try {
      const response = await saveProfessionalPilotDossier({
        saleId: sale.id,
        expectedUpdatedAt: parsed.data.workspaceRevision,
        draft: parsed.data,
      });
      if (activeStorageKey.current !== savingStorageKey) return;
      if (!response.workspace) throw new Error("Réponse du dossier indisponible.");
      setDraft({ ...parsed.data, workspaceRevision: response.workspace.updated_at });
      await queryClient.invalidateQueries({
        queryKey: ["professional-pilot-workspace", user?.id ?? null, sale.id],
      });
      await queryClient.invalidateQueries({ queryKey: ["sale-workspace", sale.id] });
      setConflict(false);
      setSaveMessage("Dossier enregistré sur votre compte.");
    } catch (error) {
      if (activeStorageKey.current !== savingStorageKey) return;
      if (error instanceof Error && error.message.includes("a changé")) {
        setConflict(true);
        void queryClient.invalidateQueries({
          queryKey: ["professional-pilot-workspace", user?.id ?? null, sale.id],
        });
      }
      setSaveMessage(
        error instanceof Error
          ? `Synchronisation impossible : ${error.message}`
          : "Synchronisation impossible. Le brouillon reste sur cet appareil.",
      );
    } finally {
      if (activeStorageKey.current === savingStorageKey) setSaving(false);
    }
  };

  const loadAccountVersion = () => {
    if (!workspaceQuery.isSuccess) return;
    const accountDraft = workspace?.private_notes.professionalDossier;
    setDraft(
      accountDraft?.kind === definition.kind
        ? { ...accountDraft, workspaceRevision: workspace?.updated_at ?? null }
        : { ...emptyPilotDraft(definition.kind), workspaceRevision: workspace?.updated_at ?? null },
    );
    setConflict(false);
    setSaveMessage(
      "Version du compte chargée. Votre ancien brouillon peut être conservé par export.",
    );
  };

  const exportPacket = () => {
    const markdown = buildPilotPacket({
      definition,
      draft,
      saleTitle: saleDisplayTitle(sale),
      saleUrl: safeDocumentUrl(sale.source_url),
      documents: documents.map((document) => ({
        label: document.label ?? document.type ?? "Document du dossier",
        url: document.url,
      })),
    });
    const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${definition.kind}-dossier-${sale.id}.md`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  return (
    <section
      id="professional-pilot"
      aria-label={definition.title}
      className="mx-auto max-w-[1260px] scroll-mt-36 px-4 py-8 sm:px-6 lg:px-8"
    >
      <div className="overflow-hidden rounded-2xl border border-[#b9d0df] bg-white shadow-sm">
        <div className="border-b border-[#d9e7ef] bg-[#eef7ff] px-5 py-6 sm:px-7">
          <p className="text-xs font-bold uppercase tracking-[0.12em] text-[#946724]">
            Pilote professionnel
          </p>
          <h2 className="mt-1 font-display text-3xl font-semibold text-brand-navy">
            {definition.title}
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-brand-navy/75">
            {definition.description}
          </p>
          <div className="mt-4 flex flex-wrap gap-2 text-xs font-semibold">
            <span className="rounded-full bg-white px-3 py-1.5 text-brand-navy">
              {readiness.verified}/{definition.checks.length} vérifications faites
            </span>
            <span className="rounded-full bg-white px-3 py-1.5 text-brand-navy">
              {readiness.missingFacts.length} faits à confirmer
            </span>
            <span className="rounded-full bg-white px-3 py-1.5 text-brand-navy">
              {
                documents.filter((document) => draft.documentStatuses[document.url] === "reviewed")
                  .length
              }
              /{documents.length} pièces relues
            </span>
            {readiness.blocked.length > 0 ? (
              <span className="rounded-full bg-rose-100 px-3 py-1.5 text-rose-800">
                {readiness.blocked.length} point(s) bloquant(s)
              </span>
            ) : null}
          </div>
          {sourceChanged ? (
            <p
              role="alert"
              className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950"
            >
              L'annonce a été mise à jour depuis votre dernière saisie. Recontrôlez les pièces et
              vos hypothèses.
            </p>
          ) : null}
          {conflict ? (
            <div
              role="alert"
              className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950"
            >
              <p>
                Une autre version du dossier existe sur votre compte. Exportez votre brouillon si
                vous souhaitez le conserver, puis chargez la version du compte.
              </p>
              <button
                type="button"
                onClick={loadAccountVersion}
                className="mt-2 min-h-10 rounded-md border border-amber-700 px-3 font-semibold"
              >
                Charger la version du compte
              </button>
            </div>
          ) : null}
        </div>

        <fieldset disabled={!editable} className="grid gap-8 p-5 sm:p-7 lg:grid-cols-2">
          <div>
            <h3 className="text-xl font-semibold text-brand-navy">Faits et échéances du dossier</h3>
            <p className="mt-1 text-xs text-slate-600">
              Les valeurs publiées sont à contrôler dans la source officielle. Une absence de donnée
              ne vaut pas confirmation.
            </p>
            <dl className="mt-4 space-y-3">
              {definition.facts.map((fact) => (
                <div
                  key={fact.label}
                  className="rounded-lg border border-slate-200 bg-[#fafcfd] p-3"
                >
                  <dt className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                    {fact.label}
                  </dt>
                  <dd className="mt-1 font-semibold text-brand-navy">
                    {fact.value ?? "À confirmer"}
                  </dd>
                  {fact.detail ? (
                    <p className="mt-1 text-xs text-slate-600">{fact.detail}</p>
                  ) : null}
                  {fact.sourceUrl ? (
                    <a
                      href={fact.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-1 inline-block text-xs font-semibold text-[#946724] underline"
                    >
                      Voir la source
                    </a>
                  ) : null}
                </div>
              ))}
            </dl>
            <h4 className="mt-6 text-base font-semibold text-brand-navy">Calendrier</h4>
            <ul className="mt-2 space-y-2 text-sm">
              {definition.milestones.map((milestone, index) => (
                <li
                  key={`${milestone.label}-${index}`}
                  className="flex flex-wrap justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2"
                >
                  <span>{milestone.label}</span>
                  <strong>{milestone.date ?? "À confirmer"}</strong>
                </li>
              ))}
            </ul>
            <p className="mt-5 text-sm font-semibold text-brand-navy">
              {definition.counterpartyLabel} : {definition.counterparty ?? "À confirmer"}
            </p>
            <p className="mt-1 text-xs text-slate-600">
              {documents.length} pièce(s) liée(s) à l'annonce. La présence d'une pièce ne valide pas
              son contenu.
            </p>
            {documents.length > 0 ? (
              <ul className="mt-3 space-y-2 text-xs">
                {documents.map((document) => (
                  <li key={document.url} className="rounded-md border border-slate-200 p-3">
                    <a
                      href={document.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-semibold text-[#946724] underline"
                    >
                      {document.label ?? document.type ?? "Document du dossier"}
                    </a>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <label className="flex items-center gap-2 text-slate-700">
                        Statut
                        <select
                          value={draft.documentStatuses[document.url] ?? "todo"}
                          onChange={(event) =>
                            updateDraft({
                              documentStatuses: {
                                ...draft.documentStatuses,
                                [document.url]: event.target.value as
                                  | "todo"
                                  | "reviewed"
                                  | "question",
                              },
                            })
                          }
                          className="min-h-9 rounded-md border border-slate-300 bg-white px-2"
                          aria-label={`Statut de la pièce : ${document.label ?? document.type ?? "Document du dossier"}`}
                        >
                          <option value="todo">À relire</option>
                          <option value="reviewed">Relue par moi</option>
                          <option value="question">Question ouverte</option>
                        </select>
                      </label>
                    </div>
                    <input
                      value={draft.documentNotes[document.url] ?? ""}
                      onChange={(event) =>
                        updateDraft({
                          documentNotes: {
                            ...draft.documentNotes,
                            [document.url]: event.target.value,
                          },
                        })
                      }
                      maxLength={1000}
                      aria-label={`Note sur la pièce : ${document.label ?? document.type ?? "Document du dossier"}`}
                      placeholder="Note ou question sur cette pièce"
                      className="mt-2 w-full rounded-md border border-slate-300 p-2"
                    />
                  </li>
                ))}
              </ul>
            ) : null}
          </div>

          <div>
            <h3 className="text-xl font-semibold text-brand-navy">Hypothèses et décision</h3>
            <p className="mt-1 text-xs text-slate-600">
              Saisissez vos propres montants. La marge est brute, avant fiscalité et aléas non
              chiffrés.
            </p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {AMOUNT_FIELDS.map(({ key, label }) => (
                <label key={key} className="block text-xs font-semibold text-brand-navy">
                  {key === "priceEur" ? definition.priceLabel : label}
                  <span className="mt-1 flex items-center rounded-md border border-slate-300 bg-white focus-within:ring-2 focus-within:ring-gold">
                    <input
                      type="number"
                      min="0"
                      max="1000000000"
                      step="1"
                      value={draft[key] ?? ""}
                      onChange={(event) =>
                        updateDraft({
                          [key]: event.target.value === "" ? null : Number(event.target.value),
                        })
                      }
                      className="min-w-0 w-full rounded-md px-3 py-2 text-sm outline-none"
                      aria-label={key === "priceEur" ? definition.priceLabel : label}
                    />
                    <span className="pr-3 text-slate-500">€</span>
                  </span>
                </label>
              ))}
            </div>
            <dl className="mt-4 grid gap-2 rounded-lg bg-[#eef7ff] p-4 text-sm sm:grid-cols-2">
              <div>
                <dt>Investissement total</dt>
                <dd className="font-bold text-brand-navy">
                  {economics.totalInvestment === null
                    ? "À chiffrer"
                    : formatPrice(economics.totalInvestment)}
                </dd>
              </div>
              <div>
                <dt>Marge brute indicative</dt>
                <dd className="font-bold text-brand-navy">
                  {economics.marginEur === null ? "À chiffrer" : formatPrice(economics.marginEur)}
                  {economics.marginPct !== null ? ` (${economics.marginPct.toFixed(1)} %)` : ""}
                </dd>
              </div>
              <div>
                <dt>Fonds propres nécessaires</dt>
                <dd className="font-bold text-brand-navy">
                  {economics.cashNeededEur === null
                    ? "À chiffrer"
                    : formatPrice(economics.cashNeededEur)}
                </dd>
              </div>
              <div>
                <dt>Prix d'entrée maximum selon vos hypothèses</dt>
                <dd className="font-bold text-brand-navy">
                  {economics.maximumEntryPriceEur === null
                    ? "À chiffrer"
                    : economics.maximumEntryPriceEur < 0
                      ? "Objectif irréalisable avec ces coûts"
                      : formatPrice(economics.maximumEntryPriceEur)}
                </dd>
              </div>
              {economics.headroomEur !== null ? (
                <div>
                  <dt>Écart avec le prix envisagé</dt>
                  <dd className="font-bold text-brand-navy">
                    {formatPrice(economics.headroomEur)}
                  </dd>
                </div>
              ) : null}
            </dl>
            <h4 className="mt-6 text-base font-semibold text-brand-navy">
              Vérifications propres à cette vente
            </h4>
            <div className="mt-2 space-y-2">
              {definition.checks.map((check) => (
                <label
                  key={check.id}
                  className="block rounded-lg border border-slate-200 p-3 text-sm"
                >
                  <span className="font-semibold text-brand-navy">{check.label}</span>
                  <span className="mt-1 block text-xs text-slate-600">{check.reason}</span>
                  <select
                    value={draft.checkStatuses[check.id] ?? "todo"}
                    onChange={(event) =>
                      updateDraft({
                        checkStatuses: {
                          ...draft.checkStatuses,
                          [check.id]: event.target.value as "todo" | "verified" | "blocked",
                        },
                      })
                    }
                    className="mt-2 min-h-10 rounded-md border border-slate-300 bg-white px-2 text-sm"
                    aria-label={`Statut : ${check.label}`}
                  >
                    <option value="todo">À vérifier</option>
                    <option value="verified">Vérifié par moi</option>
                    <option value="blocked">Bloquant</option>
                  </select>
                </label>
              ))}
            </div>
            <label className="mt-5 block text-sm font-semibold text-brand-navy">
              Questions pour {definition.counterpartyLabel.toLowerCase()}
              <textarea
                value={draft.questions}
                onChange={(event) => updateDraft({ questions: event.target.value })}
                maxLength={5000}
                rows={3}
                className="mt-1 w-full rounded-md border border-slate-300 p-3 text-sm"
                placeholder="Points à clarifier avant de vous engager"
              />
            </label>
            <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto]">
              <label className="text-sm font-semibold text-brand-navy">
                Prochaine action
                <input
                  value={draft.nextAction}
                  onChange={(event) => updateDraft({ nextAction: event.target.value })}
                  maxLength={300}
                  className="mt-1 w-full rounded-md border border-slate-300 p-2 text-sm"
                  placeholder="Ex. appeler l'organisateur"
                />
              </label>
              <label className="text-sm font-semibold text-brand-navy">
                Avant le
                <input
                  type="date"
                  value={draft.nextActionAt ?? ""}
                  onChange={(event) => updateDraft({ nextActionAt: event.target.value || null })}
                  className="mt-1 w-full rounded-md border border-slate-300 p-2 text-sm"
                />
              </label>
            </div>
          </div>
        </fieldset>
        <div className="flex flex-wrap items-center gap-3 border-t border-slate-200 px-5 py-4 sm:px-7">
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || !hydrated || (canSync && workspaceQuery.isPending)}
            className="min-h-11 rounded-md bg-brand-navy px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {saving ? "Enregistrement…" : "Enregistrer le dossier"}
          </button>
          <button
            type="button"
            onClick={exportPacket}
            className="min-h-11 rounded-md border border-brand-navy px-4 py-2 text-sm font-semibold text-brand-navy"
          >
            Exporter {definition.packetLabel.toLowerCase()}
          </button>
          <span role="status" className="text-xs text-slate-600">
            {saveMessage ||
              (canSync
                ? "Brouillon local jusqu'à l'enregistrement."
                : "Brouillon conservé sur cet appareil.")}
          </span>
        </div>
      </div>
    </section>
  );
}
