import { useMemo, useState } from "react";
import { Mail, Copy, Check, ExternalLink } from "lucide-react";
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
import type { AuctionSale } from "@/lib/types";
import { buildContactTemplate, buildGmailUrl, buildMailtoUrl } from "@/lib/contact-template";

export function ContactNotaryDialog({ sale }: { sale: AuctionSale }) {
  const [open, setOpen] = useState(false);
  const template = useMemo(() => buildContactTemplate(sale), [sale]);
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState(template.subject);
  const [body, setBody] = useState(template.body);
  const [copied, setCopied] = useState(false);

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

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
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
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-display text-2xl">Demande d'informations</DialogTitle>
          <DialogDescription>
            Mail pré-rédigé à destination de l'avocat ou du notaire en charge de la vente. Ajustez si besoin avant l'envoi.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
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
              L'adresse figure généralement sur l'annonce source ou sur le site du tribunal.
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