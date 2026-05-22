import { useMemo, useState } from "react";
import { Mail, Copy, Check, ExternalLink, Sparkles, ShieldCheck, FileSearch } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import type { AuctionContact, AuctionSale } from "@/lib/types";
import { buildContactTemplate, buildGmailUrl, buildMailtoUrl } from "@/lib/contact-template";

export function ContactNotaryDialog({
  sale,
  contacts = [],
  variant = "default",
}: {
  sale: AuctionSale;
  contacts?: AuctionContact[];
  variant?: "default" | "feature";
}) {
  const [open, setOpen] = useState(false);
  const template = useMemo(() => buildContactTemplate(sale), [sale]);

  // Pick primary contact (or first with an email) to prefill
  const initialContact = useMemo(() => {
    if (!contacts.length) return null;
    const primary = contacts.find((c) => c.is_primary && c.email);
    if (primary) return primary;
    return contacts.find((c) => c.email) ?? contacts[0];
  }, [contacts]);

  const [selectedContactId, setSelectedContactId] = useState<string>(
    initialContact?.id ?? "",
  );
  const selectedContact =
    contacts.find((c) => c.id === selectedContactId) ?? initialContact;

  const [to, setTo] = useState(initialContact?.email ?? "");
  const [subject, setSubject] = useState(template.subject);
  const [body, setBody] = useState(template.body);
  const [copied, setCopied] = useState(false);

  const handleSelectContact = (id: string) => {
    setSelectedContactId(id);
    const c = contacts.find((x) => x.id === id);
    if (c?.email) setTo(c.email);
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(`Objet : ${subject}\n\n${body}`);
      setCopied(true);
      toast.success("Mail copié dans le presse-papier");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Impossible de copier — sélectionnez le texte manuellement");
    }
  };

  const tpl = { subject, body };
  const mailto = buildMailtoUrl(to, tpl);
  const gmail = buildGmailUrl(to, tpl);

  const trigger =
    variant === "feature" ? (
      <button
        type="button"
        className="group relative block w-full overflow-hidden border border-gold/40 bg-gradient-to-br from-gold/10 via-surface/60 to-surface/30 p-6 text-left transition-all hover:border-gold hover:from-gold/15"
      >
        <span className="absolute -top-px left-6 h-px w-16 bg-gold" />
        <div className="flex items-start gap-4">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center border border-gold/40 bg-background/40 text-gold">
            <Sparkles className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[10px] uppercase tracking-[0.3em] text-gold-soft">
              Information stratégique
            </div>
            <div className="mt-1.5 font-display text-xl text-foreground">
              Contacter l'étude
            </div>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              Obtenez des informations <span className="text-foreground">plus complètes et plus fiables</span> directement auprès de l'avocat ou du notaire en charge : DPE, diagnostics, occupation, charges, modalités de visite.
            </p>
            <ul className="mt-3 space-y-1.5 text-xs text-muted-foreground">
              <li className="flex items-center gap-2"><ShieldCheck className="h-3 w-3 text-gold" /> Source officielle de la vente</li>
              <li className="flex items-center gap-2"><FileSearch className="h-3 w-3 text-gold" /> Détails absents de l'annonce publique</li>
              <li className="flex items-center gap-2"><Mail className="h-3 w-3 text-gold" /> Mail pré-rédigé — un clic suffit</li>
            </ul>
            {selectedContact?.email && (
              <div className="mt-4 inline-flex items-center gap-2 border border-gold/30 bg-background/40 px-3 py-1.5 text-[11px] text-foreground">
                <Mail className="h-3 w-3 text-gold" />
                <span className="truncate">{selectedContact.email}</span>
              </div>
            )}
          </div>
        </div>
        <div className="mt-5 inline-flex items-center gap-2 border-t border-gold/20 pt-4 text-[11px] font-semibold uppercase tracking-[0.25em] text-gold transition-colors group-hover:text-gold-soft">
          Rédiger ma demande <ExternalLink className="h-3.5 w-3.5" />
        </div>
      </button>
    ) : (
      <button
        type="button"
        className="group flex w-full items-center justify-between border border-border bg-surface/40 px-5 py-3 text-[11px] font-medium uppercase tracking-[0.25em] text-foreground transition-colors hover:border-gold/50 hover:bg-surface/70 hover:text-gold-soft"
      >
        <span className="inline-flex items-center gap-2">
          <Mail className="h-3.5 w-3.5 text-gold" />
          Contacter l'étude
        </span>
        <ExternalLink className="h-3.5 w-3.5 text-muted-foreground transition-colors group-hover:text-gold-soft" />
      </button>
    );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-display text-2xl">Demande d'informations</DialogTitle>
          <DialogDescription>
            Mail pré-rédigé pour obtenir des informations complètes et fiables auprès de l'étude. Ajustez si besoin avant l'envoi.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {contacts.length > 1 && (
            <div>
              <Label className="text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
                Contact
              </Label>
              <div className="mt-1.5 flex flex-wrap gap-2">
                {contacts.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => handleSelectContact(c.id)}
                    className={`border px-3 py-1.5 text-left text-xs transition-colors ${
                      c.id === selectedContactId
                        ? "border-gold bg-gold/10 text-foreground"
                        : "border-border text-muted-foreground hover:border-gold/40"
                    }`}
                  >
                    <div className="font-medium text-foreground">
                      {c.name ?? c.organization ?? "Contact"}
                    </div>
                    {c.role && (
                      <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                        {c.role}
                      </div>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}

          {selectedContact && (selectedContact.name || selectedContact.organization || selectedContact.phone) && (
            <div className="border border-border bg-surface/40 px-4 py-3 text-xs">
              {selectedContact.name && (
                <div className="font-medium text-foreground">{selectedContact.name}</div>
              )}
              {selectedContact.organization && (
                <div className="text-muted-foreground">{selectedContact.organization}</div>
              )}
              {selectedContact.phone && (
                <div className="mt-1 text-muted-foreground">Tél · {selectedContact.phone}</div>
              )}
            </div>
          )}

          <div>
            <Label htmlFor="contact-to" className="text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
              Destinataire
            </Label>
            <Input
              id="contact-to"
              type="email"
              placeholder="email@etude-avocat.fr"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="mt-1.5"
            />
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              {to
                ? "Adresse pré-remplie depuis la fiche. Vous pouvez la modifier."
                : "L'adresse figure généralement sur l'annonce source ou sur le site du tribunal."}
            </p>
          </div>

          <div>
            <Label htmlFor="contact-subject" className="text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
              Objet
            </Label>
            <Input
              id="contact-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="mt-1.5"
            />
          </div>

          <div>
            <Label htmlFor="contact-body" className="text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
              Message
            </Label>
            <Textarea
              id="contact-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={16}
              className="mt-1.5 font-mono text-xs leading-relaxed"
            />
          </div>

          <div className="flex flex-wrap gap-2 pt-2">
            <Button variant="outline" onClick={handleCopy} className="gap-2">
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              {copied ? "Copié" : "Copier"}
            </Button>
            <Button asChild variant="outline" className="gap-2">
              <a href={gmail} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-4 w-4" />
                Ouvrir dans Gmail
              </a>
            </Button>
            <Button asChild className="ml-auto gap-2 bg-gold text-background hover:bg-gold-soft">
              <a href={mailto}>
                <Mail className="h-4 w-4" />
                Ouvrir mon client mail
              </a>
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}