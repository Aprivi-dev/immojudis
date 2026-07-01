SYSTEM_PROMPT = (
    "MODE EXTRACTION STRICTE. Ne produis aucune étape intermédiaire. "
    "Commence immédiatement par { et termine par }. "
    "Tu es un extracteur de données spécialisé dans les ventes aux enchères "
    "immobilières judiciaires françaises. Tu agis comme un analyste de due "
    "diligence : tu identifies les faits importants, leur source, les "
    "contradictions et les incertitudes. Tu dois extraire uniquement les "
    "informations explicitement présentes dans les documents fournis. Tu ne dois "
    "jamais déduire, compléter, arrondir ou inventer. Si une information est "
    "absente, contradictoire, illisible ou ambiguë, retourne null ou unknown, "
    "signale l'incertitude et baisse fortement la confiance. Réponds uniquement "
    "avec un objet JSON valide, sans markdown, sans commentaire et sans texte "
    "avant ou après."
)


def build_user_prompt(context_text: str) -> str:
    return (
        "Voici le texte extrait de l’annonce source originale et des documents PDF d’une vente immobilière judiciaire. "
        "Extrais les informations structurées selon le schéma demandé. Ne fais aucune "
        "supposition non justifiée. La réponse doit commencer par { et se terminer par }. "
        "Aucun markdown, aucune explication hors JSON.\n\n"
        "Règles anti-hallucination obligatoires :\n"
        "- N'extrais une valeur que si elle est explicitement écrite dans le texte fourni.\n"
        "- N'utilise pas tes connaissances générales, le nom de la ville, le type d'annonce ou des habitudes de marché.\n"
        "- Si le texte contient plusieurs valeurs contradictoires pour le même champ, retourne null ou unknown.\n"
        "- Si une valeur semble venir d'un tableau de diagnostics, d'un DPE, d'une page, d'un article ou d'un numéro de lot, ne l'utilise pas.\n"
        "- Ne convertis pas les ares/centiares en m² sauf si le document donne explicitement une surface en m².\n"
        "- Les champs texte doivent rester courts et citer les mots utiles du document quand c'est possible.\n\n"
        "Règles synthèse d'affichage Immojudis :\n"
        "- display_description réécrit uniquement le bloc descriptif de l'annonce source, repéré par les libellés Description source, source_description ou source_blocks.description.\n"
        "- N'utilise pas les PDF, diagnostics ou cahiers pour enrichir display_description ; ces documents servent aux autres champs d'analyse.\n"
        "- Si aucun descriptif source exploitable n'est fourni, si le texte indique un paywall/abonnement, ou si le descriptif est trop vague, retourne display_description null.\n"
        "- Rédige une synthèse uniforme en français naturel, 80 à 130 mots maximum, en 1 à 2 courts paragraphes, sans markdown, sans puces, sans promesse commerciale.\n"
        "- Conserve tous les faits importants écrits dans le descriptif source : type, localisation, surface, composition, annexes, occupation, visites, lots, accès ou dépendances si explicitement présents.\n"
        "- Ne supprime pas une information significative uniquement pour rendre le texte plus fluide ; raccourcis seulement les formulations redondantes ou publicitaires.\n"
        "- N'ajoute aucun conseil juridique, estimation de marché, avantage supposé ou information absente du descriptif source.\n"
        "- Ne mentionne jamais que le texte a été reformulé par un LLM.\n\n"
        "Règles surfaces :\n"
        "- surface_m2 doit représenter la surface principale du bien, pas une surface de terrain, garage, cave, dépendance, local annexe ou piscine.\n"
        "- Pour un appartement, privilégie une surface loi Carrez explicitement mentionnée.\n"
        "- Pour une maison, privilégie une surface habitable explicitement mentionnée.\n"
        "- Pour un terrain/parcelle, utilise une contenance uniquement si le bien est clairement un terrain.\n"
        "- Ne somme jamais plusieurs surfaces sauf si le texte indique explicitement un total.\n"
        "- Si seule une surface annexe est visible, retourne surface_m2 null et confidence.surface_m2 0.\n\n"
        "Règles pièces et chambres :\n"
        "- rooms_count correspond au nombre de pièces principales. T3 signifie 3 pièces.\n"
        "- F3, type 3, type trois signifient aussi 3 pièces principales.\n"
        "- bedrooms_count correspond uniquement aux chambres explicitement mentionnées.\n"
        "- Ne déduis pas bedrooms_count depuis rooms_count.\n"
        "- Compte les chambres quand le texte dit par exemple deux chambres, 3 chambres, chambre n°1/chambre n°2.\n"
        "- Ne compte pas cuisine, salle de bains, WC, dégagement, couloir, cave, garage ou terrasse comme pièces principales.\n"
        "- Studio signifie rooms_count 1. Ne mets bedrooms_count à 0 que si le texte indique clairement studio ou absence de chambre séparée.\n\n"
        "Règles occupation :\n"
        "- vacant uniquement si le texte dit libre, vacant ou inoccupé.\n"
        "- rented uniquement si le texte mentionne bail, location, loyer ou locataire.\n"
        "- owner_occupied uniquement si propriétaire occupant est explicitement écrit.\n"
        "- occupied si occupé est mentionné sans précision fiable.\n"
        "- Si des passages se contredisent, retourne unknown.\n\n"
        "Règles risques :\n"
        "- legal_risks et physical_risks doivent contenir uniquement des risques explicitement mentionnés.\n"
        "- Une simple clause standard du cahier des conditions ne suffit pas à créer un risque.\n"
        "- servitudes ne doit contenir que les servitudes explicitement citées.\n"
        "- works_needed doit rester null sauf si le texte décrit clairement des travaux, dégradations, ruine, vétusté ou désordres.\n\n"
        "Règles confidence :\n"
        "- 0.90 à 1.00 : valeur explicite, proche d'un libellé clair.\n"
        "- 0.70 à 0.89 : valeur explicite mais contexte un peu bruité.\n"
        "- 0.55 à 0.69 : valeur plausible mais faible; évite cette zone sauf nécessité.\n"
        "- 0.00 à 0.54 : absent, ambigu, contradictoire ou incertain.\n"
        "- Toute valeur non null doit avoir une confiance cohérente avec une preuve textuelle claire.\n\n"
        "Règles preuves :\n"
        "- Pour chaque champ non null ou chaque risque retenu, remplis evidence avec une citation courte du texte.\n"
        "- La citation doit être copiée depuis le texte fourni, sans reformulation.\n"
        "- Si le contexte indique une annonce source, un document ou une page, renseigne document_label et page_number quand disponible.\n"
        "- Si tu n'as pas de citation claire, laisse la valeur null/unknown.\n\n"
        "Règles due diligence premium :\n"
        "- investment_facts doit lister uniquement des faits vérifiables utiles à l'investisseur.\n"
        "- Chaque fait doit avoir status confirmé, infirmé ou incertain.\n"
        "- contradictions doit signaler les conflits entre annonce, PV, CCV, diagnostics ou autres pièces.\n"
        "- analysis_questions doit répondre aux questions métier clés : occupation, surface, travaux, diagnostics, servitudes, liquidité.\n"
        "- scoring_guidance doit expliquer l'impact probable sur le scoring, sans inventer de prix de marché.\n"
        "- Un mot isolé comme plomb, travaux ou servitude ne suffit jamais : explique le contexte exact.\n\n"
        "Schéma JSON attendu, sans markdown et sans commentaire :\n"
        "{\n"
        '  "property_type": "apartment|house|building|land|commercial|parking|mixed|other|unknown|null",\n'
        '  "display_description": null,\n'
        '  "surface_m2": 0.0,\n'
        '  "rooms_count": null,\n'
        '  "bedrooms_count": null,\n'
        '  "occupancy_status": "vacant|occupied|rented|owner_occupied|squatted|unknown|null",\n'
        '  "occupancy_details": null,\n'
        '  "legal_risks": [],\n'
        '  "physical_risks": [],\n'
        '  "copropriete": null,\n'
        '  "servitudes": [],\n'
        '  "works_needed": null,\n'
        '  "summary": null,\n'
        '  "investor_notes": null,\n'
        '  "confidence": {\n'
        '    "property_type": 0.0,\n'
        '    "surface_m2": 0.0,\n'
        '    "rooms_count": 0.0,\n'
        '    "bedrooms_count": 0.0,\n'
        '    "occupancy_status": 0.0,\n'
        '    "legal_risks": 0.0,\n'
        '    "physical_risks": 0.0,\n'
        '    "copropriete": 0.0,\n'
        '    "servitudes": 0.0,\n'
        '    "display_description": 0.0,\n'
        '    "summary": 0.0\n'
        "  },\n"
        '  "evidence": {\n'
        '    "property_type": {"quote": null, "document_label": null, "page_number": null},\n'
        '    "surface_m2": {"quote": null, "document_label": null, "page_number": null},\n'
        '    "rooms_count": {"quote": null, "document_label": null, "page_number": null},\n'
        '    "bedrooms_count": {"quote": null, "document_label": null, "page_number": null},\n'
        '    "occupancy_status": {"quote": null, "document_label": null, "page_number": null},\n'
        '    "legal_risks": [{"quote": null, "document_label": null, "page_number": null}],\n'
        '    "physical_risks": [{"quote": null, "document_label": null, "page_number": null}],\n'
        '    "servitudes": [{"quote": null, "document_label": null, "page_number": null}]\n'
        "  },\n"
        '  "investment_facts": [\n'
        '    {"category": "asset|legal|technical|financial|evidence", "key": null, "status": "confirmed|negated|uncertain", "statement": null, "quote": null, "document_label": null, "page_number": null, "confidence": 0.0}\n'
        "  ],\n"
        '  "contradictions": [\n'
        '    {"field": null, "statement": null, "sources": [], "quote": null, "document_label": null, "page_number": null, "confidence": 0.0}\n'
        "  ],\n"
        '  "analysis_questions": [\n'
        '    {"question": null, "answer": null, "status": "answered|to_verify|unknown", "quote": null, "document_label": null, "page_number": null}\n'
        "  ],\n"
        '  "scoring_guidance": [\n'
        '    {"axis": "financial_attractiveness|asset_quality|legal_security|liquidity_resale|analysis_confidence", "impact": "positive|negative|neutral|uncertain", "reasoning": null, "quote": null, "document_label": null, "page_number": null}\n'
        "  ]\n"
        "}\n\n"
        "Texte fourni :\n"
        f"{context_text}"
    )
