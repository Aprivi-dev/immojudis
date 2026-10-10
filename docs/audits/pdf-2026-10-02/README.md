# Corpus PDF public — audit du 2 octobre 2026

Ce dossier contient le corpus local utilisé pour éprouver l'extraction documentaire d'Immojudis. Le corpus principal comprend sept pièces variées : fiche AGRASC/urbanisme, DPE et procès-verbal tribunal scannés, cahier/diagnostic/plan parcellaire de cession de l'État, et dossier Info-Enchères mixte. Quatre pièces supplémentaires ciblent les faux positifs de classes DPE demandés pour la production.

Le [manifeste](./manifest.json) est la source de vérité pour les URLs, sources, types de lots, dates observées, tailles, SHA-256, nombre de pages, métriques d'extraction et statuts de transport. Le [relevé ground truth](./ground-truth.md) donne les champs vérifiés visuellement, page par page, ainsi que le périmètre de chaque lot, unité ou tableau.

Les PDF originaux, les pages PNG, les probes HTML d'erreur et les documents complémentaires sont conservés localement pour inspection. Ils peuvent contenir des adresses, signatures ou informations de procédure : le dépôt public doit garder le manifeste et le relevé textuel, pas ces fichiers bruts. Aucun appel LLM payant, accès base de données ou modification du code applicatif n'a été effectué pour ce corpus.

## Rejouer hors réseau

Depuis la racine du dépôt, après avoir récupéré les fichiers locaux :

```bash
python3 -m json.tool docs/audits/pdf-2026-10-02/manifest.json >/dev/null
```

Vérifier les empreintes déclarées dans le manifeste :

```bash
python3 - <<'PY'
import hashlib
import json
from pathlib import Path

root = Path("docs/audits/pdf-2026-10-02")
manifest = json.loads((root / "manifest.json").read_text())
for item in manifest["documents"]:
    path = root / item["local_path"]
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    assert digest == item["sha256"], (item["id"], digest, item["sha256"])
print(f"{len(manifest['documents'])} PDF SHA-256 OK")
PY
```

Mesurer un PDF avec l'environnement déjà présent :

```bash
services/data-pipeline/.venv/bin/python -c "import fitz,sys; d=fitz.open(sys.argv[1]); print({'pages':len(d),'text_chars':sum(len(p.get_text()) for p in d)})" path/to/file.pdf
```

Rendre une page ciblée pour une nouvelle inspection visuelle :

```bash
services/data-pipeline/.venv/bin/python -c "import fitz,sys; d=fitz.open(sys.argv[1]); p=d[int(sys.argv[2])-1]; pix=p.get_pixmap(matrix=fitz.Matrix(1.5,1.5),alpha=False); pix.save(sys.argv[3])" path/to/file.pdf 1 /private/tmp/pdf-page.png
```

La revue visuelle initiale a été faite avec PyMuPDF et les pages ciblées sont listées dans `manifest.json` et `ground-truth.md`. Les pages scannées ne sont pas considérées comme validées par le seul texte extrait.

## Sources non accessibles en PDF

Les pages Licitor capturées exposaient une fiche HTML sans URL de document (`documents: []`). Les fiches/API Notaires observées répondaient, mais aucun PDF public n'était exposé dans le DOM ou les réponses gelées. Les probes reproductibles sont décrites dans `manifest.json` et dans la section « Limites de transport » de `ground-truth.md`; une absence source reste une absence et ne doit pas être transformée en échec d'extraction.
