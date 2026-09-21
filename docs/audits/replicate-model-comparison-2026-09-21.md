# Comparatif Replicate du 21 septembre 2026

Le [benchmark GitHub Actions](https://github.com/Aprivi-dev/immojudis/actions/runs/35613391016) a exécuté les prompts du pipeline sur six cas synthétiques : trois descriptions publiques, deux extractions courtes et une extraction d'un document de 9 563 caractères. Chaque modèle a reçu les mêmes cas. Les critères vérifient le JSON, les champs attendus et plusieurs erreurs factuelles connues.

| Modèle | Cas réussis | Coût estimé des six cas | Durée cumulée |
| --- | ---: | ---: | ---: |
| Qwen2 7B Instruct, modèle précédent | 4/6 | 0,232257 $ | 274,26 s |
| Qwen3.7 Plus | **6/6** | **0,010072 $** | **61,93 s** |
| Gemini 2.5 Flash | 2/6 | 0,029084 $ | 112,74 s |

Qwen3.7 Plus coûte environ 23 fois moins que Qwen2 et répond environ 4,4 fois plus vite sur cet échantillon. Qwen2 a omis la surface et le nombre de chambres du document long. Gemini a produit du JSON invalide lors de deux extractions et des descriptions incomplètes. Les coûts sont calculés à partir du temps de calcul ou des compteurs de tokens renvoyés par Replicate ; ils ne constituent pas une facture.

Décision : utiliser `qwen/qwen3-7-plus` par défaut pour les nouveaux appels. Les analyses Qwen2 déjà complètes restent valides si les documents, preuves et versions de prompts sont inchangés. La migration `20260921110000_pipeline_token_pricing.sql` réserve un coût maximal avant chaque appel autonome et conserve les plafonds de dépenses et d'appels. Elle a été [appliquée en production](https://github.com/Aprivi-dev/immojudis/actions/runs/35614248100) avant l'activation du nouveau modèle.

Ce test reste un échantillon synthétique : surveiller les erreurs JSON, les descriptions rejetées et le coût réel des premiers scans. Les tarifs et paliers utilisés sont ceux publiés par [Qwen3.7 Plus](https://replicate.com/qwen/qwen3-7-plus) et [Gemini 2.5 Flash](https://replicate.com/google/gemini-2.5-flash) sur Replicate au 21 septembre 2026.
