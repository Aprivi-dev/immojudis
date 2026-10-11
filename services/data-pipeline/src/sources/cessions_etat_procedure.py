"""Procédure de vente d'une fiche « Cessions immobilières de l'État » (fonctions pures).

Le bloc « Procédure de vente » publie le mode de cession (« par Appel
d'offres », « par Vente par enchères en ligne », « par Adjudication »…), parfois
un état (« Procédure à venir », « Date à venir »), une date d'adjudication et un
commentaire libre où figurent les dates limites, fenêtres d'enchères, visites
et montants. Le descriptif répète souvent ces modalités. Chaque valeur gardée
ici est citée dans la page ; une année absente (« le mardi 23 juin ») n'est
déduite que de la date de modification de la fiche, et marquée comme telle.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any
from zoneinfo import ZoneInfo

from src.sources.cessions_etat_labels import fold

PARIS = ZoneInfo("Europe/Paris")
METHODS = (
    ("vente_notariale_interactive", "Vente notariale interactive",
     r"vente notariale interactive|\bvni\b|immo[- ]?interactif"),
    ("encheres_en_ligne", "Enchères en ligne", r"encheres? en ligne|vente par encheres en ligne|agorastore|encheres interactives"),
    ("adjudication", "Adjudication", r"adjudication"),
    ("appel_offres", "Appel d'offres", r"appel (?:a )?d'? ?offres?|pli cachete|plis"),
    ("gre_a_gre", "Vente de gré à gré", r"gre a gre|vente amiable"),
)
_MONTHS = {
    "janvier": 1, "fevrier": 2, "mars": 3, "avril": 4, "mai": 5, "juin": 6, "juillet": 7,
    "aout": 8, "septembre": 9, "octobre": 10, "novembre": 11, "decembre": 12,
}
_TIME = r"(?:\s*(?:a|à|-|,)?\s*(?P<hour>[01]?\d|2[0-3])\s*(?:h|heures?|:)\s*(?P<minute>[0-5]\d)?)?"
_NUMERIC_DATE = re.compile(r"\b(?P<day>[0-3]?\d)/(?P<month>[01]?\d)/(?P<year>\d{4}|\d{2})\b" + _TIME, re.I)
_TEXT_DATE = re.compile(
    r"\b(?:(?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\s+)?(?P<day>[0-3]?\d)(?:er)?\s+"
    r"(?P<month>janvier|f[ée]vrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[ée]cembre)"
    r"(?:\s+(?P<year>\d{4}))?" + _TIME,
    re.I,
)
_MONEY = r"(?P<amount>\d{1,3}(?:[ .  ]\d{3})+|\d+)(?:,\d{1,2})?\s*(?:€|euros?\b|eur\b)"
_PRICE_PATTERNS = (
    ("reserve_price_eur", re.compile(r"prix\s+de\s+r[ée]serve\s*:?\s*(?:de\s+)?" + _MONEY, re.I)),
    ("floor_price_eur", re.compile(r"prix\s+(?:minimum|plancher)\s+(?:de\s+)?" + _MONEY, re.I)),
    ("starting_price_eur", re.compile(
        r"mise\s+[àa]\s+prix(?:\s+avec\s+prix\s+de\s+r[ée]serve)?\s*:?\s*(?:de\s+)?" + _MONEY, re.I)),
    ("starting_price_eur", re.compile(r"1\s*(?:[èe]re|er)\s+offre\s+possible\s*:?\s*" + _MONEY, re.I)),
    ("minimum_price_eur", re.compile(r"prix\s+minimum\s+attendu\s*:?\s*(?:de\s+)?" + _MONEY, re.I)),
    ("deposit_eur", re.compile(r"consignation\s*:?\s*(?:de\s+)?" + _MONEY, re.I)),
    ("bid_increment_eur", re.compile(
        r"(?:minimum\s+du\s+)?pas\s+des\s+(?:ench[eè]res|offres)\s*:?\s*" + _MONEY, re.I)),
    ("property_tax_eur", re.compile(r"taxe\s+fonci[eè]re[^.\n€]{0,40}?(?:est\s+de|s['’][ée]l[eè]v\w*\s+[àa]|:)\s*"
                                    + _MONEY, re.I)),
    ("asking_price_eur", re.compile(
        r"(?:^|[\s(])prix(?:\s+de\s+(?:vente|cession)|\s+attendu(?:\s+par\s+l['’][ée]tat)?)?\s*:?\s*" + _MONEY, re.I)),
    ("asking_price_eur", re.compile(r"pour\s+un\s+montant\s+de\s+" + _MONEY, re.I)),
)
_DEADLINE_CUES = re.compile(
    r"date\s+limite|au\s+plus\s+tard|prend\s+fin|fin\s+de\s+l['’]appel|remise\s+des\s+(?:offres|plis)|"
    r"r[ée]ception\s+des\s+(?:offres|plis)|r[ée]ceptionn[ée]s|d[ée]p[oô]t\s+des\s+(?:offres|plis|candidatures)|"
    r"envoi\s+des\s+offres|fin\s+des\s+ench[eè]res|cl[oô]ture|offres?\s+avant|se\s+terminera|fin\s*:?\s*$",
    re.I,
)
_WINDOW_CUES = re.compile(r"ench[eè]res?|vente|vni|offres|immo[- ]?interactive|r[ée]ception|d[ée]p[oô]t", re.I)
_VISIT_CUE = re.compile(r"\bvisites?\b|rendez[- ]vous", re.I)
_PENDING_RE = re.compile(r"proc[ée]dure\s+(?:de\s+vente\s+)?[àa]\s+venir|date\s+[àa]\s+venir|vente\s+[àa]\s+venir", re.I)
_SOLD_RE = re.compile(r"^vendu\s+le\s+(\d{1,2}/\d{1,2}/\d{4})", re.I)
_DAY_RANGE_RE = re.compile(
    r"\bdu\s+(?:(?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\s+)?(?P<first>[0-3]?\d)(?:er)?\s+au\s+"
    r"(?P<second>(?:(?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\s+)?[0-3]?\d(?:er)?\s+"
    r"(?:janvier|f[ée]vrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[ée]cembre))",
    re.I,
)


@dataclass(frozen=True)
class FoundDate:
    start: int
    end: int
    moment: datetime  # heure civile de Paris (naïve) ; minuit si l'heure manque
    has_time: bool
    year_inferred: bool

    def iso(self) -> str:
        if not self.has_time:
            return self.moment.date().isoformat()
        return self.moment.replace(tzinfo=PARIS).isoformat()


def _reference_date(reference: date | None) -> date:
    return reference or datetime.now(PARIS).date()


def find_dates(text: str, reference: date | None = None) -> list[FoundDate]:
    """Dates citées dans un texte, dans l'ordre ; années manquantes déduites de ``reference``."""
    found: list[FoundDate] = []
    taken: list[tuple[int, int]] = []
    for pattern in (_NUMERIC_DATE, _TEXT_DATE):
        for match in pattern.finditer(text):
            if any(start <= match.start() < end for start, end in taken):
                continue
            parsed = _match_date(match, reference)
            if parsed is None:
                continue
            found.append(parsed)
            taken.append((match.start(), match.end()))
    return sorted(found, key=lambda item: item.start)


def _match_date(match: re.Match[str], reference: date | None) -> FoundDate | None:
    day = int(match.group("day"))
    raw_month = match.group("month")
    month = int(raw_month) if raw_month.isdigit() else _MONTHS.get(fold(raw_month))
    if not month:
        return None
    year_text = match.group("year")
    inferred = False
    if year_text:
        year = int(year_text) + (2000 if len(year_text) == 2 else 0)
    else:
        base = _reference_date(reference)
        year = base.year
        try:
            if date(year, month, day) < base - timedelta(days=45):
                year += 1
        except ValueError:
            return None
        inferred = True
    hour = match.group("hour")
    minute = match.group("minute")
    try:
        moment = datetime(year, month, day, int(hour) if hour else 0, int(minute) if minute else 0)
    except ValueError:
        return None
    if not 2000 <= year <= 2100:
        return None
    return FoundDate(match.start(), match.end(), moment, bool(hour), inferred)


def _sentences(lines: list[str]) -> list[str]:
    sentences: list[str] = []
    for line in lines:
        for part in re.split(r"(?<=[.!?;])\s+(?=[A-ZÀ-Ý0-9])", line):
            if part.strip():
                sentences.append(part.strip())
    return sentences


def method_of(text: str | None) -> tuple[str, str] | None:
    folded = fold(text).replace("’", "'")
    for code, label, pattern in METHODS:
        if re.search(pattern, folded):
            return code, label
    return None


def _amount(match: re.Match[str]) -> str | None:
    digits = re.sub(r"[^\d]", "", match.group("amount"))
    try:
        value = Decimal(digits)
    except InvalidOperation:
        return None
    return str(value) if value >= 100 else None


def extract_prices(text: str) -> dict[str, str]:
    prices: dict[str, str] = {}
    for key, pattern in _PRICE_PATTERNS:
        if key in prices:
            continue
        match = pattern.search(text)
        if match:
            amount = _amount(match)
            if amount:
                prices[key] = amount
    return prices


def published_price(prices: dict[str, str]) -> str | None:
    """Prix affiché : mise à prix (ou 1re offre), sinon prix demandé, sinon prix minimum attendu."""
    for key in ("starting_price_eur", "asking_price_eur", "minimum_price_eur"):
        if prices.get(key):
            return prices[key]
    return None


def _classify(sentence: str, dates: list[FoundDate]) -> list[tuple[str, FoundDate]]:
    """Rôle de chaque date d'une phrase, d'après les mots qui la précèdent."""
    roles: list[tuple[str, FoundDate]] = []
    previous_end = 0
    for index, found in enumerate(dates):
        cue = sentence[previous_end : found.start]
        before = sentence[max(0, found.start - 90) : found.start]
        previous_end = found.end
        if re.search(r"\bdate\s+d['’]adjudication\b", before, re.I):
            roles.append(("adjudication", found))
        elif _VISIT_CUE.search(sentence[: found.start]) and not _DEADLINE_CUES.search(cue) and not re.search(
            r"ench[eè]res|vente\s+(?:aux|par|en)|r[ée]ception\s+des|d[ée]p[oô]t", cue, re.I
        ):
            roles.append(("visit", found))
        elif re.search(r"\b(?:du|à\s+partir\s+du|a\s+partir\s+du|d[ée]but[^:]{0,30}:?)\s*(?:\w+\s+)?$", cue, re.I) and index + 1 < len(dates) and _WINDOW_CUES.search(sentence):
            roles.append(("window_open", found))
        elif roles and roles[-1][0] == "window_open" and re.search(
            r"\b(?:au|fin\s*:?|se\s+terminera\s+le|jusqu['’]au)\s*(?:\w+\s+)?$", cue, re.I
        ):
            roles.append(("window_close", found))
        elif _DEADLINE_CUES.search(before):
            roles.append(("deadline", found))
        elif re.search(r"adjudication|ench[eè]res?\s+le|vente\s+aux\s+ench[eè]res\s+le", before, re.I):
            roles.append(("auction", found))
        else:
            roles.append(("other", found))
    return roles


def analyse_procedure(
    procedure_lines: list[str],
    description: str | None,
    *,
    reference: date | None = None,
) -> dict[str, Any]:
    """Profil de procédure lu dans le bloc « Procédure de vente » puis le descriptif."""
    head = procedure_lines[0] if procedure_lines else ""
    method_line = re.sub(r"^par\s+", "", head, flags=re.I).strip() if head.lower().startswith("par ") else None
    procedure_text = "\n".join(procedure_lines)
    result: dict[str, Any] = {}
    method = method_of(method_line) if method_line else None
    if method:
        result["method"], result["method_label"] = method
    if method_line:
        result["method_source_label"] = method_line
    if _PENDING_RE.search(procedure_text):
        result["pending"] = True
    comment_lines = [
        re.sub(r"^commentaire\s*:\s*", "", line, flags=re.I)
        for line in procedure_lines[1:]
        if not _PENDING_RE.fullmatch(line.strip(" .")) and not line.lower().startswith("date à venir")
    ]
    comment = "\n".join(line for line in comment_lines if line and not line.lower().startswith("date d'adjudication"))
    if comment:
        result["comment"] = comment[:2000]
    for line in procedure_lines:
        sold = _SOLD_RE.match(line)
        if sold:
            found = find_dates(sold.group(1), reference)
            if found:
                result["sold_on"] = found[0].moment.date().isoformat()
    _collect_dates(result, procedure_lines, reference, scope="procedure")
    if description:
        _collect_dates(result, description.splitlines(), reference, scope="description")
    prices = extract_prices(procedure_text)
    for key, value in extract_prices(description or "").items():
        prices.setdefault(key, value)
    if prices:
        result["prices"] = prices
    if not method:
        # Le commentaire de la procédure fait foi ; le descriptif seulement si la procédure n'est pas « à venir ».
        described = method_of(comment) if comment else None
        if described is None and description and not result.get("pending"):
            described = method_of(description)
        if described:
            result["method"], result["method_label"] = described
            result["method_inferred_from_text"] = True
    return result


def _day_range_window(sentence: str, reference: date | None) -> dict[str, Any] | None:
    """« Vente aux enchères du 17 au 19 novembre 2026 » : fenêtre à la journée."""
    match = _DAY_RANGE_RE.search(sentence)
    if not match or not _WINDOW_CUES.search(sentence[: match.start()] or sentence):
        return None
    closing = find_dates(sentence[match.start("second") :], reference)
    if not closing:
        return None
    end = closing[0].moment
    try:
        start = end.replace(day=int(match.group("first")))
    except ValueError:
        return None
    if start >= end:
        return None
    return {"opens_at": start.date().isoformat(), "closes_at": end.date().isoformat(), "has_time": False,
            **({"year_inferred": True} if closing[0].year_inferred else {})}


def _collect_dates(result: dict[str, Any], lines: list[str], reference: date | None, *, scope: str) -> None:
    for sentence in _sentences(lines):
        window = _day_range_window(sentence, reference)
        if window:
            result.setdefault("windows", []).append({**window, "scope": scope, "quote": sentence[:300]})
            continue
        dates = find_dates(sentence, reference)
        if not dates:
            continue
        for role, found in _classify(sentence, dates):
            entry = {"at": found.iso(), "scope": scope, "quote": sentence[:300]}
            if found.year_inferred:
                entry["year_inferred"] = True
            if role == "adjudication":
                _keep_adjudication(result, found, sentence, scope)
            elif role == "visit":
                visits = result.setdefault("visits", [])
                if sentence[:300] not in visits:
                    visits.append(sentence[:300])
            elif role == "window_open":
                result.setdefault("_window_open", []).append((scope, found, sentence))
            elif role == "window_close":
                opens = result.get("_window_open") or []
                if opens:
                    open_scope, opened, quote = opens.pop()
                    if found.moment > opened.moment:
                        result.setdefault("windows", []).append(
                            {"opens_at": opened.iso(), "closes_at": found.iso(), "scope": open_scope, "quote": quote[:300],
                             "has_time": opened.has_time and found.has_time,
                             **({"year_inferred": True} if opened.year_inferred or found.year_inferred else {})}
                        )
            elif role == "deadline":
                result.setdefault("deadlines", []).append(entry)
            elif role == "auction":
                result.setdefault("auctions", []).append(entry)
    result.pop("_window_open", None)


def _keep_adjudication(result: dict[str, Any], found: FoundDate, sentence: str, scope: str) -> None:
    if "adjudication" in result:
        return
    result["adjudication"] = {"at": found.iso(), "scope": scope, "quote": sentence[:300]}


def attach_adjudication_time(result: dict[str, Any], reference: date | None) -> None:
    """« Date d'adjudication : 26/10/2026 » + commentaire « … le 26 octobre 2026 à 14h30 »."""
    adjudication = result.get("adjudication")
    if not isinstance(adjudication, dict) or "T" in str(adjudication.get("at")):
        return
    day = str(adjudication.get("at"))[:10]
    for found in find_dates(str(result.get("comment") or ""), reference):
        if found.has_time and found.moment.date().isoformat() == day:
            adjudication["at"] = found.iso()
            return
    for item in result.get("auctions") or []:
        if str(item.get("at", "")).startswith(day) and "T" in str(item.get("at")):
            adjudication["at"] = item["at"]
            return


def select_schedule(result: dict[str, Any]) -> dict[str, Any] | None:
    """Échéance retenue pour ``sale_date`` : adjudication, fenêtre d'enchères puis date limite.

    Le bloc « Procédure de vente » prime sur le descriptif ; une échéance du
    descriptif n'est utilisée que si la procédure est connue (pas « à venir »).
    """
    scopes = ("procedure",) if result.get("pending") else ("procedure", "description")
    for scope in scopes:
        adjudication = result.get("adjudication")
        if isinstance(adjudication, dict) and adjudication.get("scope") == scope:
            return {"kind": "adjudication", "at": adjudication["at"], "scope": scope, "quote": adjudication.get("quote")}
        windows = [item for item in result.get("windows") or [] if item.get("scope") == scope]
        if windows:
            window = max(windows, key=lambda item: item["closes_at"])
            return {"kind": "sale_window_close", "at": window["closes_at"], "opens_at": window["opens_at"],
                    "scope": scope, "quote": window.get("quote"), "has_time": window.get("has_time")}
        deadlines = [item for item in result.get("deadlines") or [] if item.get("scope") == scope]
        if deadlines:
            deadline = max(deadlines, key=lambda item: item["at"][:10])
            return {"kind": "offer_deadline", "at": deadline["at"], "scope": scope, "quote": deadline.get("quote")}
        auctions = [item for item in result.get("auctions") or [] if item.get("scope") == scope]
        if auctions and result.get("method") in {"adjudication", "encheres_en_ligne", "vente_notariale_interactive"}:
            auction = max(auctions, key=lambda item: item["at"][:10])
            return {"kind": "adjudication", "at": auction["at"], "scope": scope, "quote": auction.get("quote")}
    return None


def countdown_end(days: int | None, observed_at: datetime | None) -> date | None:
    """Fin d'annonce estimée à partir du compte à rebours « Fini dans N jours »."""
    if days is None or observed_at is None:
        return None
    observed = observed_at.astimezone(PARIS) if observed_at.tzinfo else observed_at.replace(tzinfo=PARIS)
    return (observed + timedelta(days=days)).date()
