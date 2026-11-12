"""Écho de la collecte face au registre des pièces : scénarios A, B et C contre une vraie base au schéma complet.

Une pièce est posée, remplacée ou retirée par la projection du registre (seconde connexion, comme une décision
d'administrateur) pendant qu'un passage de collecte a déjà lu la vente. Le passage écrit ensuite par son vrai chemin
(``fetch_known_sale_details`` puis ``upsert_sales_to_supabase`` : verrou, résolution d'identité, écriture de toutes les
tables). Attendu : la valeur seulement relue n'est pas réécrite, aucun évènement « l'annonce a changé » n'est créé,
la valeur d'annonce mémorisée reste celle de l'annonce.

Ces tests écrivent dans la base : il leur faut une base **jetable et locale** où toutes les migrations sont rejouées
(base Supabase locale du job « Supabase migrations + pgTAP », ou PostgreSQL local amorcé comme elle) :

    PIPELINE_REGISTRY_DB_URL=postgresql://postgres@127.0.0.1:55600/replay python -m pytest -s \
        tests/test_base_echo_registry_postgres.py

Sans ``PIPELINE_REGISTRY_DB_URL`` ils sont ignorés, sauf si ``PIPELINE_REGISTRY_DB_REQUIRED=1`` (étape de la CI) :
l'absence de base est alors un échec. Toute base non locale est refusée. Le journal des décisions est en ajout seul :
chaque exécution y laisse ses lignes, sous des identifiants neufs. ``-s`` affiche la transcription.

Une seule classe, ``Registry``, pose les observations et les décisions (``_insert_claim``, ``_insert_decision``) : si
le registre change la façon de les écrire (gardes par rôle, fonction d'administration), c'est là qu'il faut adapter.
"""

from __future__ import annotations

import ipaddress
import os
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from src import base_reads
from src import main as pipeline
from src.asset_normalization import normalize_asset_features
from src.config import load_settings
from src.freshness import record_source_checks
from src.models import AuctionSale
from src.normalize import normalize_sale
from src.storage import supabase_client as storage

DB_URL_ENV = "PIPELINE_REGISTRY_DB_URL"
LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})
# Réseaux que Docker attribue par défaut à ses ponts (172.17.0.0/16 puis les suivants).
DOCKER_BRIDGE = ipaddress.ip_network("172.16.0.0/12")
# Variables que le pilote lit en plus de l'adresse et qui changent l'hôte réellement joint.
REDIRECTING_ENV = ("PGHOSTADDR", "PGSERVICE")
# Réglage par défaut de ``auction_fact_fields.on_listing_change`` (migrations du registre).
DEFAULT_ON_LISTING_CHANGE = "keep_and_review"
REQUIRED_ENV = "PIPELINE_REGISTRY_DB_REQUIRED"
ROOMS = "property.rooms_count"
SURFACE = "property.surface_m2"
SALE_DATE = (datetime.now(UTC) + timedelta(days=30)).replace(microsecond=0).isoformat()
SURFACE_COLUMNS = ("surface_m2", "app_surface_m2", "app_surface_kind", "surface_source", "surface_confidence")


def _db_url() -> str:
    url = os.getenv(DB_URL_ENV)
    if not url:
        if os.getenv(REQUIRED_ENV) == "1":
            pytest.fail(f"{DB_URL_ENV} est absente alors que {REQUIRED_ENV}=1 : les scénarios n'ont pas été joués.")
        pytest.skip(f"{DB_URL_ENV} absente : base au schéma complet non disponible")
    hosts = _connection_hosts(url)
    if not hosts or not set(hosts) <= LOCAL_HOSTS:
        pytest.fail(f"{DB_URL_ENV} doit désigner une base locale (hôtes {hosts!r} refusés) : ces tests écrivent.")
    redirecting = [name for name in REDIRECTING_ENV if os.getenv(name)]
    if redirecting:
        pytest.fail(
            f"{', '.join(redirecting)} est posée : le pilote joindrait un autre hôte que celui de {DB_URL_ENV}. "
            "Ces tests écrivent et n'acceptent qu'une base locale."
        )
    return url


def _connection_hosts(url: str) -> list[str]:
    """Tous les hôtes que la connexion peut joindre, tels que le pilote les lit (``host`` et ``hostaddr``).

    Une liste vide est refusée par l'appelant : sans hôte dans l'adresse, le pilote prend celui de l'environnement
    (``PGHOST``) ou une socket locale, et rien ne dit lequel.
    """
    import psycopg
    from psycopg.conninfo import conninfo_to_dict

    try:
        parameters = conninfo_to_dict(url)
    except psycopg.Error:
        pytest.fail(f"{DB_URL_ENV} n'est pas une adresse de connexion lisible.")
    return [
        host.strip()
        for key in ("host", "hostaddr")
        for host in str(parameters.get(key) or "").split(",")
        if host.strip()
    ]


def _server_is_local(server: str | None, connection_host: str | None) -> bool:
    """Vrai si l'adresse que le serveur dit avoir est celle d'une base locale, pour une connexion faite à cet hôte.

    * bouclage, ou nulle (socket) : local ;
    * adresse du pont Docker (``DOCKER_BRIDGE``) quand la connexion vise le bouclage : c'est une base dans un
      conteneur de cette machine, jointe par son port publié (base Supabase locale, job de la CI). Le serveur y
      voit l'adresse de son conteneur, pas ``127.0.0.1`` ;
    * tout le reste, dont toute adresse publique : refusé.

    Limite : un tunnel local (port du bouclage relayé vers une base distante dont l'adresse privée tombe dans cette
    plage) passerait ce contrôle. Restent alors le contrôle du propriétaire de la projection, et le fait que ces
    tests ne tournent que si ``PIPELINE_REGISTRY_DB_URL`` est posée. La plage est volontairement la seule que
    Docker emploie par défaut : un Docker configuré sur ``192.168.0.0/16`` ou ``10.0.0.0/8`` sera refusé, plutôt
    que d'admettre les plages où vivent la plupart des réseaux privés et des bases hébergées.
    """
    import ipaddress

    if server is None:
        return True
    address = ipaddress.ip_address(server)
    if address.is_loopback:
        return True
    return connection_host in LOCAL_HOSTS and address in DOCKER_BRIDGE


def _require_projection_owner(db: Any) -> None:
    """Avant la première écriture : la base jointe est locale, et le rôle est le propriétaire de la projection.

    L'adresse est vérifiée du côté du serveur (ce que la connexion a réellement joint, quoi qu'en dise son
    adresse), voir ``_server_is_local``. Les scénarios posent des pièces comme le fait la projection, et les gardes
    par rôle du registre refusent tout autre rôle : on ne les contourne pas, on le dit.
    """
    server = db.execute("select pg_catalog.host(pg_catalog.inet_server_addr())").fetchone()[0]
    if not _server_is_local(server, db.info.host):
        pytest.fail(
            f"La connexion (hôte {db.info.host!r}) a joint {server}, qui n'est pas une base locale : ces tests écrivent."
        )
    found = db.execute(
        """select pg_catalog.pg_get_userbyid(routine.proowner), current_user
           from pg_catalog.pg_proc routine
           join pg_catalog.pg_namespace schema on schema.oid = routine.pronamespace
           where schema.nspname = 'app_private' and routine.proname = 'project_sale_fields'"""
    ).fetchone()
    if found is None:
        pytest.fail("app_private.project_sale_fields est absente : les migrations du registre ne sont pas rejouées.")
    owner, user = found
    if owner != user:
        pytest.fail(
            f"Ces scénarios doivent se connecter avec le rôle propriétaire de app_private.project_sale_fields "
            f"({owner!r}) ; la connexion utilise {user!r}. Les gardes par rôle du registre refuseraient ses écritures."
        )


def test_a_missing_database_is_fatal_when_the_scenarios_are_required(monkeypatch) -> None:
    """Dans la CI, une étape qui ne trouverait pas sa base ne doit pas passer pour un succès."""
    monkeypatch.delenv(DB_URL_ENV, raising=False)
    monkeypatch.setenv(REQUIRED_ENV, "1")
    # ``BaseException`` : un saut (``skip``) ne doit pas faire sauter ce test lui-même, mais le faire échouer.
    with pytest.raises(BaseException) as required:
        _db_url()
    assert isinstance(required.value, pytest.fail.Exception) and DB_URL_ENV in str(required.value)

    monkeypatch.delenv(REQUIRED_ENV)
    with pytest.raises(BaseException) as optional:
        _db_url()
    assert isinstance(optional.value, pytest.skip.Exception)


@pytest.mark.parametrize(
    "url",
    [
        "postgresql://postgres@db.example.test:5432/postgres",
        # L'adresse numérique l'emporte sur le nom : un nom local ne suffit pas.
        "postgresql://postgres@localhost:5432/postgres?hostaddr=203.0.113.7",
        "host=127.0.0.1 hostaddr=203.0.113.7 dbname=postgres",
        # Plusieurs hôtes : tous doivent être locaux.
        "postgresql://postgres@127.0.0.1:5432,db.example.test:5432/postgres",
        # Sans hôte, le pilote prendrait celui de l'environnement.
        "postgresql:///postgres",
        "dbname=postgres user=postgres",
        "postgresql://postgres@%2Fvar%2Frun%2Fpostgresql/postgres",
    ],
)
def test_a_database_that_is_not_local_is_refused(monkeypatch, url) -> None:
    monkeypatch.setenv(DB_URL_ENV, url)
    with pytest.raises(pytest.fail.Exception, match="locale"):
        _db_url()


@pytest.mark.parametrize("name", ["PGHOSTADDR", "PGSERVICE"])
def test_a_local_address_redirected_by_the_environment_is_refused(monkeypatch, name) -> None:
    """``PGHOSTADDR`` l'emporte sur l'hôte de l'adresse, ``PGSERVICE`` peut le remplacer : le pilote joindrait ailleurs."""
    monkeypatch.setenv(DB_URL_ENV, "postgresql://postgres@127.0.0.1:55600/replay")
    monkeypatch.setenv(name, "203.0.113.7" if name == "PGHOSTADDR" else "ailleurs")
    with pytest.raises(pytest.fail.Exception, match=name):
        _db_url()


class _JoinedServer:
    """Une connexion faite à ``host`` dont le serveur dit avoir l'adresse ``server``."""

    def __init__(self, host: str, server: str | None):
        self.info = type("Info", (), {"host": host})()
        self.server = server
        self.statements: list[str] = []

    def execute(self, statement: str):
        self.statements.append(statement)
        if "inet_server_addr" in statement:
            return type("Rows", (), {"fetchone": lambda _self: (self.server,)})()
        return type("Rows", (), {"fetchone": lambda _self: ("postgres", "postgres")})()


@pytest.mark.parametrize(
    ("host", "server"),
    [
        ("127.0.0.1", "127.0.0.1"),
        ("localhost", "::1"),
        ("127.0.0.1", None),  # socket
        # Base dans un conteneur de cette machine, jointe par son port publié : Supabase local, job de la CI.
        ("127.0.0.1", "172.18.0.2"),
        ("localhost", "172.17.0.3"),
        ("::1", "172.31.255.254"),
    ],
)
def test_a_local_server_is_accepted(host, server) -> None:
    db = _JoinedServer(host, server)

    _require_projection_owner(db)

    assert len(db.statements) == 2  # l'adresse du serveur, puis le propriétaire de la projection


@pytest.mark.parametrize(
    ("host", "server"),
    [
        # Adresse publique : refusée, même si la connexion vise le bouclage (tunnel, redirection de port).
        ("127.0.0.1", "203.0.113.7"),
        ("localhost", "2001:db8::7"),
        # Plages privées que Docker n'emploie pas par défaut : celles des réseaux privés et des bases hébergées.
        ("127.0.0.1", "192.168.1.20"),
        ("127.0.0.1", "10.0.0.5"),
        ("127.0.0.1", "172.32.0.1"),  # juste au-delà de la plage du pont
        # L'adresse du pont ne vaut que pour une connexion au bouclage.
        ("172.18.0.2", "172.18.0.2"),
        ("db.example.test", "172.18.0.2"),
    ],
)
def test_a_server_that_is_not_local_is_refused_before_any_write(host, server) -> None:
    """Le contrôle se fait sur ce que le serveur dit de lui-même, pas sur l'adresse demandée."""
    db = _JoinedServer(host, server)

    with pytest.raises(pytest.fail.Exception, match="n'est pas une base locale"):
        _require_projection_owner(db)

    assert len(db.statements) == 1 and "inet_server_addr" in db.statements[0]


def test_an_address_on_the_docker_bridge_is_already_refused_as_a_connection_host(monkeypatch) -> None:
    """En amont du contrôle côté serveur : on ne se connecte qu'au bouclage, jamais directement au conteneur."""
    monkeypatch.setenv(DB_URL_ENV, "postgresql://postgres@172.18.0.2:5432/postgres")
    with pytest.raises(pytest.fail.Exception, match="locale"):
        _db_url()


@pytest.mark.parametrize(
    "url",
    ["postgresql://postgres@127.0.0.1:55600/replay", "postgresql://postgres:mot@localhost:54322/postgres?hostaddr=127.0.0.1"],
)
def test_a_local_database_is_accepted(monkeypatch, url) -> None:
    monkeypatch.setenv(DB_URL_ENV, url)
    for name in REDIRECTING_ENV:
        monkeypatch.delenv(name, raising=False)
    assert _db_url() == url


def test_a_connection_that_does_not_own_the_projection_is_refused_with_a_clear_message() -> None:
    import psycopg

    with psycopg.connect(_db_url(), autocommit=True) as db:
        _require_projection_owner(db)  # le rôle de la connexion : accepté
        db.execute("set role service_role")
        with pytest.raises(pytest.fail.Exception, match="propriétaire de app_private.project_sale_fields"):
            _require_projection_owner(db)
        db.execute("reset role")
        users_before = db.execute("select count(*) from auth.users").fetchone()[0]

    # La connexion des scénarios fait ce contrôle avant toute écriture.
    from psycopg.conninfo import make_conninfo

    with pytest.raises(pytest.fail.Exception, match="propriétaire de app_private.project_sale_fields"):
        Registry(make_conninfo(_db_url(), options="-c role=service_role"))
    with psycopg.connect(_db_url(), autocommit=True) as db:
        assert db.execute("select count(*) from auth.users").fetchone()[0] == users_before


def say(text: str) -> None:
    print(text)  # transcription des scénarios, affichée par ``pytest -s``


class Registry:
    """La seconde connexion : celle d'un administrateur qui décide pendant que la collecte tourne."""

    def __init__(self, url: str):
        import psycopg

        self.db = psycopg.connect(url, autocommit=True)
        self.admin = str(uuid.uuid4())
        self.case = str(uuid.uuid4())
        try:
            _require_projection_owner(self.db)
            self._create_admin()
        except BaseException:
            self.db.close()
            raise

    def _create_admin(self) -> None:
        self.db.execute("insert into auth.users (id) values (%s)", (self.admin,))
        self.db.execute(
            """insert into public.user_profiles (user_id, email, user_role) values (%s, %s, 'admin')
               on conflict (user_id) do update set user_role = excluded.user_role""",
            (self.admin, f"registre-echo-{self.admin[:8]}@example.test"),
        )

    def close(self) -> None:
        self.db.close()

    @contextmanager
    def listing_change(self, field: str, value: str) -> Iterator[None]:
        """Joue un scénario sous ce réglage, puis remet le réglage par défaut du registre.

        Le défaut connu, pas la valeur lue en entrant : deux exécutions en même temps se rendraient sinon l'une à
        l'autre un réglage de test, et il resterait en place.
        """
        self.set_setting(field, value)
        try:
            yield
        finally:
            self.set_setting(field, DEFAULT_ON_LISTING_CHANGE)

    def set_setting(self, field: str, value: str) -> None:
        self.db.execute(
            "update public.auction_fact_fields set on_listing_change = %s where field_key = %s", (value, field)
        )

    def sale_id(self, url: str) -> str:
        return str(self.db.execute("select id from public.auction_sales where source_url = %s", (url,)).fetchone()[0])

    def accept(self, sale_id: str, field: str, value: int, received_at: str) -> str:
        """Une réponse d'avocat devient une observation, puis une pièce acceptée, puis elle est projetée."""
        claim_id = self._insert_claim(sale_id, field, value)
        self._insert_decision(claim_id, "accepted", None, received_at)
        self.project(sale_id)
        return claim_id

    def withdraw(self, sale_id: str, *claim_ids: str) -> None:
        for claim_id in claim_ids:
            self._insert_decision(claim_id, "withdrawn", "entry_error", None)
        self.project(sale_id)

    def _insert_claim(self, sale_id: str, field: str, value: int) -> str:
        """Seul endroit qui pose une observation."""
        from psycopg.types.json import Jsonb

        claim_id = str(uuid.uuid4())
        self.db.execute(
            """insert into public.auction_fact_claims (id, auction_sale_id, field_key, value_jsonb, evidence_kind,
                 evidence_locator, source_url, confidence_score, extractor_name, extractor_version, created_by)
               values (%s, %s, %s, %s, 'professional_email', %s, null, 0.9, 'information_agent', 'v1', %s)""",
            (claim_id, sale_id, field, Jsonb(value), Jsonb({"case_id": self.case}), self.admin),
        )
        return claim_id

    def _insert_decision(self, claim_id: str, decision: str, reason: str | None, received_at: str | None) -> None:
        """Seul endroit qui pose une décision."""
        self.db.execute(
            """insert into public.auction_fact_claim_decisions (claim_id, sale_id, field_key, decision,
                 lot_attachment, actor_kind, actor_id, reason_code, recipient_kind, received_at)
               select claim.id, claim.auction_sale_id, claim.field_key, %s, 'single_lot', 'admin', %s, %s,
                      'source_lawyer', %s
               from public.auction_fact_claims claim where claim.id = %s""",
            (decision, self.admin, reason, received_at, claim_id),
        )

    def project(self, sale_id: str, *, apply: bool = True) -> dict[str, Any]:
        return self.db.execute("select app_private.project_sale_fields(%s, null, %s)", (sale_id, apply)).fetchone()[0]

    def row(self, sale_id: str) -> dict[str, Any]:
        columns = (*SURFACE_COLUMNS, "rooms_count", "occupancy_status", "held_fields")
        values = self.db.execute(
            f"select {', '.join(columns)} from public.auction_sales where id = %s", (sale_id,)
        ).fetchone()
        return dict(zip(columns, values, strict=True))

    def held(self, sale_id: str) -> set[str]:
        """Les champs qu'une pièce tient. Une entrée libérée (``released``) ne garde que la mémoire d'écho."""
        entries = self.row(sale_id)["held_fields"] or {}
        return {field for field, entry in entries.items() if entry.get("state") in ("held", "conflicted")}

    def listing_memory(self, sale_id: str, field: str) -> Any:
        """La valeur d'annonce mémorisée pour un champ tenu (bloc ``listing``)."""
        held = self.row(sale_id)["held_fields"] or {}
        return (held.get(field) or {}).get("listing")

    def listing_events(self, sale_id: str) -> list[tuple[str, Any]]:
        return self.db.execute(
            """select event, incoming_value from public.auction_sale_field_hold_events
               where sale_id = %s and event like 'listing\\_changed%%' order by seq""",
            (sale_id,),
        ).fetchall()

    def echo_events(self, sale_id: str) -> list[tuple[str, Any]]:
        """Les retours écartés par le filet de la base : un chemin que la garde de la collecte n'a pas couvert."""
        return self.db.execute(
            """select field_key, incoming_value from public.auction_sale_field_hold_events
               where sale_id = %s and event = 'echo_suppressed' order by seq""",
            (sale_id,),
        ).fetchall()

    def describe(self, sale_id: str) -> str:
        row = self.row(sale_id)
        held = ", ".join(sorted(self.held(sale_id))) or "rien"
        return (
            f"pièces={row['rooms_count']} surface={row['surface_m2']}/{row['app_surface_m2']} "
            f"nature={row['app_surface_kind']} source={row['surface_source']} | champs tenus : {held}"
        )


@pytest.fixture
def registry(monkeypatch) -> Iterator[Registry]:
    url = _db_url()
    settings = {
        **load_settings(),
        "supabase_url": "http://127.0.0.1:9",  # jamais appelée : toute écriture passe par la connexion directe
        "supabase_service_role_key": "local-test-only",
        "supabase_db_url": url,
    }
    monkeypatch.setattr(storage, "load_settings", lambda: settings)
    helper = Registry(url)
    try:
        yield helper
    finally:
        helper.close()


@pytest.fixture
def sent(monkeypatch) -> list[dict[str, Any]]:
    """Les lignes ``auction_sales`` que la collecte envoie réellement à la base."""
    rows: list[dict[str, Any]] = []
    real_write = storage._transaction_write

    def recording_write(table, payload, on_conflict=None, **kwargs):
        if table == "auction_sales":
            rows.extend(dict(row) for row in payload)
        return real_write(table, payload, on_conflict, **kwargs)

    monkeypatch.setattr(storage, "_transaction_write", recording_write)
    return rows


def _url() -> str:
    number = uuid.uuid4().int % 10**9
    return f"https://www.licitor.com/annonce/09/99/99/vente-aux-encheres/une-maison/alphaville/gironde/{number:09d}.html"


def _collect(raw: dict[str, Any], known: dict[str, dict[str, Any]]) -> AuctionSale:
    raws = [raw]
    pipeline._hydrate_known_unchanged_sales(raws, known)
    pipeline._preserve_known_enrichment_payloads(raws, known)
    record_source_checks(raws, known)
    sale = normalize_sale(raw)
    normalize_asset_features(sale)
    return sale


def _card(url: str, **values: Any) -> dict[str, Any]:
    return {
        "source_name": "licitor",
        "source_url": url,
        "sale_date": SALE_DATE,
        "starting_price_eur": 90000,
        "status": "upcoming",
        "city": "Alphaville",
        "postal_code": "33000",
        "address": "12 rue des Lilas, 33000 Alphaville",
        **values,
    }


def publish_listing(url: str, **values: Any) -> None:
    """Première collecte : l'annonce dit 50 m² et 2 pièces, bien occupé."""
    raw = _card(
        url, property_type="house", title="Une maison", surface_m2=50, rooms_count=2, bedrooms_count=1,
        occupancy_status="occupé", description="Une maison d'habitation de 50 m², 2 pièces, occupée.",
        raw_text="Une maison d'habitation de 50 m², 2 pièces, occupée.", source_detail_status="complete", **values,
    )
    assert storage.upsert_sales_to_supabase([_collect(raw, {})]) == 1


def start_a_run_and_read(url: str) -> AuctionSale:
    """Début d'un passage : lecture des ventes connues, puis l'annonce est vue inchangée (fiche non relue)."""
    base_reads.reset()
    known = storage.fetch_known_sale_details()
    known.update(storage.fetch_known_sale_details(source_urls=[url], include_enrichment_payload=True))
    assert url in known
    return _collect(_card(url, _known_unchanged=True), known)


def without_the_guard(monkeypatch) -> None:
    monkeypatch.setattr(base_reads, "suppress_echo", lambda existing, incoming: incoming)


# --- A. Retrait pendant l'import --------------------------------------------------------------------------------------------


def _scenario_a(registry: Registry, label: str) -> tuple[str, AuctionSale]:
    url = _url()
    publish_listing(url)
    sale_id = registry.sale_id(url)
    say(f"{label}1 annonce publiée            : {registry.describe(sale_id)}")
    rooms = registry.accept(sale_id, ROOMS, 3, "2026-11-01 09:00+00")
    surface = registry.accept(sale_id, SURFACE, 54, "2026-11-01 09:00+00")
    say(f"{label}2 deux pièces acceptées      : {registry.describe(sale_id)}")
    sale = start_a_run_and_read(url)
    say(f"{label}3 lu par la collecte         : pièces={sale.rooms_count} surface={sale.app_surface_m2}")
    assert (sale.rooms_count, sale.app_surface_m2) == (3, 54)
    registry.withdraw(sale_id, rooms, surface)
    say(f"{label}4 retrait pendant l'import   : {registry.describe(sale_id)}")
    assert storage.upsert_sales_to_supabase([sale]) == 1
    say(f"{label}5 après l'écriture collecte  : {registry.describe(sale_id)}")
    say(f"{label}6 évènements « annonce changée » : {registry.listing_events(sale_id)}")
    say(f"{label}7 simulation de projection   : changed={registry.project(sale_id, apply=False)['changed']}")
    say(f"{label}8 retours écartés par la base : {registry.echo_events(sale_id)}")
    return sale_id, sale


def test_scenario_a_a_value_withdrawn_during_the_import_does_not_come_back(registry, sent) -> None:
    say("\n=== A. Retrait pendant l'import, avec la garde d'écho ===")
    sale_id, _sale = _scenario_a(registry, "A")

    row = registry.row(sale_id)
    assert row["rooms_count"] == 2
    assert (row["surface_m2"], row["app_surface_m2"]) == (50, 50)
    assert row["surface_source"] != "fact_registry"  # le libellé réservé à la projection ne reste pas
    assert registry.held(sale_id) == set()
    assert registry.listing_events(sale_id) == []
    assert registry.echo_events(sale_id) == []  # le filet de la base n'a rien eu à écarter
    assert registry.project(sale_id, apply=False)["changed"] is False
    # Ce que la collecte a envoyé : la valeur de la base au moment de l'écriture, pas celle lue avant le retrait.
    assert (sent[-1]["rooms_count"], sent[-1]["surface_m2"], sent[-1]["app_surface_m2"]) == (2, 50, 50)
    assert base_reads.suppressed_count() == 2
    say(f"A9 groupes retenus par la garde   : {base_reads.suppressed_count()} (pièces, surface)")


def test_scenario_a_without_the_guard_the_collection_sends_the_withdrawn_value(registry, sent, monkeypatch) -> None:
    """Témoin : le même scénario sans la garde. La collecte renvoie la valeur retirée, et c'est le filet de la base
    (mémoire d'écho) qui l'écarte : l'évènement ``echo_suppressed``, que la garde tient à zéro, apparaît."""
    without_the_guard(monkeypatch)
    say("\n=== A (témoin). Même scénario sans la garde ===")
    sale_id, _sale = _scenario_a(registry, "A'")

    assert (sent[-1]["rooms_count"], sent[-1]["surface_m2"], sent[-1]["app_surface_m2"]) == (3, 54, 54)
    assert {field for field, _value in registry.echo_events(sale_id)} == {ROOMS, SURFACE}


# --- B et C. Remplacement pendant l'import ---------------------------------------------------------------------------------


def _scenario_replacement(registry: Registry, label: str) -> tuple[str, str, str]:
    url = _url()
    publish_listing(url)
    sale_id = registry.sale_id(url)
    first = registry.accept(sale_id, ROOMS, 3, "2026-11-01 09:00+00")
    say(f"{label}1 pièce « 3 pièces » posée   : {registry.describe(sale_id)}")
    say(f"{label}2 valeur d'annonce mémorisée : {registry.listing_memory(sale_id, ROOMS)}")
    sale = start_a_run_and_read(url)
    say(f"{label}3 lu par la collecte         : pièces={sale.rooms_count}")
    assert sale.rooms_count == 3
    second = registry.accept(sale_id, ROOMS, 4, "2026-11-02 09:00+00")
    say(f"{label}4 remplacée par « 4 pièces » : {registry.describe(sale_id)}")
    assert storage.upsert_sales_to_supabase([sale]) == 1
    say(f"{label}5 après l'écriture collecte  : {registry.describe(sale_id)}")
    say(f"{label}6 évènements « annonce changée » : {registry.listing_events(sale_id)}")
    say(f"{label}7 valeur d'annonce mémorisée : {registry.listing_memory(sale_id, ROOMS)}")
    say(f"{label}7b retours écartés par la base : {registry.echo_events(sale_id)}")
    return sale_id, first, second


def test_scenario_b_a_replaced_value_is_not_reported_as_a_listing_change(registry, sent) -> None:
    with registry.listing_change(ROOMS, "keep_and_review"):
        say("\n=== B. Remplacement pendant l'import, réglage keep_and_review, avec la garde d'écho ===")
        sale_id, first, second = _scenario_replacement(registry, "B")

        assert registry.row(sale_id)["rooms_count"] == 4
        assert registry.listing_events(sale_id) == []
        assert registry.listing_memory(sale_id, ROOMS) == {"rooms_count": 2}
        assert sent[-1]["rooms_count"] == 4
        assert registry.echo_events(sale_id) == []
        assert base_reads.suppressed_count() == 1

        registry.withdraw(sale_id, first, second)
        say(f"B8 après retrait des deux pièces  : {registry.describe(sale_id)}")
        # La fiche revient à ce que dit l'annonce : la valeur mémorisée n'a pas été faussée par l'écho.
        assert registry.row(sale_id)["rooms_count"] == 2
        assert registry.held(sale_id) == set()


def test_scenario_c_a_replaced_value_does_not_release_the_field(registry, sent) -> None:
    with registry.listing_change(ROOMS, "listing_wins_and_review"):
        say("\n=== C. Remplacement pendant l'import, réglage listing_wins_and_review, avec la garde d'écho ===")
        sale_id, _first, _second = _scenario_replacement(registry, "C")

        assert registry.row(sale_id)["rooms_count"] == 4
        assert registry.listing_events(sale_id) == []
        assert ROOMS in registry.held(sale_id)
        assert registry.echo_events(sale_id) == []
        assert sent[-1]["rooms_count"] == 4
        state = registry.project(sale_id)["fields"][ROOMS]["state"]
        say(f"C8 reprojection                   : état={state} | {registry.describe(sale_id)}")
        # La pièce tient toujours le champ (« held » à la pose, « unchanged » quand rien n'est à réécrire) : la
        # décision de l'administrateur n'est pas défaite, la projection ne rend pas le champ à l'annonce.
        assert state in {"held", "unchanged"}
        assert registry.row(sale_id)["rooms_count"] == 4
        assert registry.row(sale_id)["held_fields"][ROOMS]["value"] == 4


@pytest.mark.parametrize("setting", ["keep_and_review", "listing_wins_and_review"])
def test_scenarios_b_and_c_without_the_guard_the_collection_sends_the_replaced_value(
    registry, sent, monkeypatch, setting
) -> None:
    """Témoin des scénarios B et C sans la garde : la valeur remplacée repart, le filet de la base l'écarte."""
    without_the_guard(monkeypatch)
    with registry.listing_change(ROOMS, setting):
        say(f"\n=== {'B' if setting == 'keep_and_review' else 'C'} (témoin). Même scénario sans la garde ({setting}) ===")
        sale_id, first, second = _scenario_replacement(registry, "T")
        assert sent[-1]["rooms_count"] == 3
        assert [field for field, _value in registry.echo_events(sale_id)] == [ROOMS]
        registry.withdraw(sale_id, first, second)
        say(f"T8 après retrait des deux pièces  : {registry.describe(sale_id)}")


# --- Régime permanent : rien ne bouge, la collecte écrit comme avant -----------------------------------------------------


def test_a_held_sale_is_rewritten_without_event_when_nothing_moves(registry, sent) -> None:
    say("\n=== Régime permanent : champ tenu, annonce inchangée, rien ne bouge pendant l'import ===")
    url = _url()
    publish_listing(url)
    sale_id = registry.sale_id(url)
    registry.accept(sale_id, ROOMS, 3, "2026-11-01 09:00+00")
    registry.accept(sale_id, SURFACE, 54, "2026-11-01 09:00+00")
    before = registry.row(sale_id)

    for _passage in range(2):
        sale = start_a_run_and_read(url)
        # Publication anticipée, puis publication finale du même passage.
        for _publication in range(2):
            assert storage.upsert_sales_to_supabase([sale]) == 1
            assert (sent[-1]["rooms_count"], sent[-1]["app_surface_m2"]) == (3, 54)
            # Aucun mouvement, aucune valeur retenue : la base rend à chaque fois ce qu'elle a gardé de l'écriture.
            assert base_reads.moved_groups(sale_id) == frozenset()
            assert base_reads.suppressed_count() == 0

    say(f"P1 après deux passages            : {registry.describe(sale_id)}")
    assert registry.row(sale_id) == before
    assert registry.listing_events(sale_id) == []
    assert registry.echo_events(sale_id) == []
    assert registry.project(sale_id, apply=False)["changed"] is False


def test_a_held_surface_and_a_reread_listing_never_look_like_a_move(registry, sent) -> None:
    """Surface tenue à 54 m², fiche relue qui publie toujours 50 m² habitables, personne n'agit.

    La base retient 54 à chaque écriture. La garde note ce que la base a gardé (``returning``), pas ce qui a été
    envoyé : la lecture suivante n'est pas un mouvement, et la valeur de l'annonce continue de partir vers la base
    sans être remplacée par la valeur tenue.
    """
    say("\n=== Surface tenue, fiche relue à 50 m² habitables : deux passages de deux publications ===")
    url = _url()
    listing = dict(
        property_type="house", title="Une maison", surface_m2=50, habitable_surface_m2=50, rooms_count=2,
        bedrooms_count=1, occupancy_status="occupé", source_detail_status="complete",
        description="Une maison d'habitation de 50 m² habitables, 2 pièces, occupée.",
        raw_text="Une maison d'habitation de 50 m² habitables, 2 pièces, occupée.",
    )
    assert storage.upsert_sales_to_supabase([_collect(_card(url, **listing), {})]) == 1
    sale_id = registry.sale_id(url)
    registry.accept(sale_id, SURFACE, 54, "2026-11-01 09:00+00")
    memory = registry.listing_memory(sale_id, SURFACE)

    for passage in range(2):
        base_reads.reset()
        known = storage.fetch_known_sale_details()
        known.update(storage.fetch_known_sale_details(source_urls=[url], include_enrichment_payload=True))
        sale = _collect(_card(url, **listing), known)  # la source publie toujours 50 m²
        for publication in range(2):
            assert storage.upsert_sales_to_supabase([sale]) == 1
            say(
                f"H{passage + 1}.{publication + 1} envoyé surface={sent[-1]['surface_m2']}/{sent[-1]['app_surface_m2']} "
                f"| groupes « bougés » : {sorted(base_reads.moved_groups(sale_id))} | compteur={base_reads.suppressed_count()}"
            )
            assert (sent[-1]["surface_m2"], sent[-1]["app_surface_m2"]) == (50, 50)
            assert base_reads.moved_groups(sale_id) == frozenset()
            assert base_reads.suppressed_count() == 0

    say(f"H3 après deux passages            : {registry.describe(sale_id)}")
    row = registry.row(sale_id)
    assert (row["surface_m2"], row["app_surface_m2"]) == (54, 54)
    assert registry.listing_events(sale_id) == []
    assert registry.echo_events(sale_id) == []
    assert registry.listing_memory(sale_id, SURFACE) == memory


def test_scenario_d_a_piece_posed_during_the_import_survives_a_sale_merged_from_another_source(registry, sent) -> None:
    """Limite connue de la garde côté collecte, couverte par la retenue côté base.

    Une seconde source (Avoventes) est relue et fusionnée dans la ligne Licitor à la publication anticipée. La vente
    en mémoire porte alors le ``raw_payload`` stocké de la ligne canonique, sans marqueur « non relue » : à la
    publication finale, la garde ne retient pas forcément ses valeurs. Une pièce posée entre les deux publications ne
    doit pourtant pas être écrasée dans la colonne : c'est la retenue de la base qui le garantit.
    """
    say("\n=== D. Pose pendant l'import, vente fusionnée entre deux sources ===")
    url = _url()
    # Une adresse propre au scénario : le rapprochement entre sources se fait par l'adresse, et les ventes des autres
    # scénarios (ou d'un passage précédent sur la même base) partagent la date et la mise à prix.
    address = f"{uuid.uuid4().int % 9000 + 1} chemin des Acacias, 33000 Alphaville"
    publish_listing(url, address=address)
    sale_id = registry.sale_id(url)
    other_url = f"https://www.avoventes.fr/enchere/une-maison-alphaville-{uuid.uuid4().hex[:12]}"
    base_reads.reset()
    known = storage.fetch_known_sale_details()
    known.update(storage.fetch_known_sale_details(source_urls=[url], include_enrichment_payload=True))
    second = _collect(
        _card(
            other_url, source_name="avoventes", address=address, property_type="house", title="Une maison", surface_m2=50,
            rooms_count=2, bedrooms_count=1, occupancy_status="occupé", source_detail_status="complete",
            description="Une maison d'habitation de 50 m², 2 pièces, occupée.",
            raw_text="Une maison d'habitation de 50 m², 2 pièces, occupée.",
        ),
        known,
    )

    assert storage.upsert_sales_to_supabase([second]) == 1  # publication anticipée : fusion dans la ligne Licitor
    assert second.source_url == url and registry.sale_id(url) == sale_id
    merged_rows = registry.db.execute(
        "select count(*) from public.auction_sales where source_url = %s", (other_url,)
    ).fetchone()[0]
    assert merged_rows == 0
    say(f"D1 seconde source fusionnée        : {registry.describe(sale_id)}")

    registry.accept(sale_id, ROOMS, 3, "2026-11-01 09:00+00")
    registry.accept(sale_id, SURFACE, 54, "2026-11-01 09:00+00")
    say(f"D2 deux pièces posées pendant l'import : {registry.describe(sale_id)}")

    assert storage.upsert_sales_to_supabase([second]) == 1  # publication finale de la même vente en mémoire
    say(
        f"D3 envoyé par la collecte          : pièces={sent[-1]['rooms_count']} "
        f"surface={sent[-1]['surface_m2']}/{sent[-1]['app_surface_m2']} | retenus par la garde : {base_reads.suppressed_count()}"
    )
    say(f"D4 après l'écriture collecte       : {registry.describe(sale_id)}")
    say(f"D5 évènements « annonce changée »   : {registry.listing_events(sale_id)}")
    say(f"D6 valeur d'annonce mémorisée      : {registry.listing_memory(sale_id, ROOMS)}")

    row = registry.row(sale_id)
    assert row["rooms_count"] == 3
    assert (row["surface_m2"], row["app_surface_m2"]) == (54, 54)
    assert {ROOMS, SURFACE} <= registry.held(sale_id)
    assert registry.echo_events(sale_id) == []
    # La collecte a renvoyé la valeur de l'annonce, que la base connaît : ce n'est pas un « changement de l'annonce ».
    assert registry.listing_events(sale_id) == []
    assert registry.listing_memory(sale_id, ROOMS) == {"rooms_count": 2}


def test_the_scenario_connection_is_closed_when_its_setup_fails(monkeypatch) -> None:
    """Le contrôle du rôle passe, puis une insertion échoue : la connexion ne reste pas ouverte."""
    import psycopg

    opened: list[Any] = []
    real_connect = psycopg.connect

    def connect(*args, **kwargs):
        opened.append(real_connect(*args, **kwargs))
        return opened[-1]

    def failing_setup(self) -> None:
        raise RuntimeError("insertion refusée")

    monkeypatch.setattr(psycopg, "connect", connect)
    monkeypatch.setattr(Registry, "_create_admin", failing_setup)
    with pytest.raises(RuntimeError, match="insertion refusée"):
        Registry(_db_url())

    assert [connection.closed for connection in opened] == [True]


def test_a_scenario_setting_goes_back_to_the_registry_default_even_when_the_scenario_fails(registry) -> None:
    def setting() -> str:
        return registry.db.execute(
            "select on_listing_change from public.auction_fact_fields where field_key = %s", (ROOMS,)
        ).fetchone()[0]

    registry.set_setting(ROOMS, "listing_wins_and_review")  # laissé par une autre exécution, au même moment
    with pytest.raises(RuntimeError, match="scénario"), registry.listing_change(ROOMS, "listing_wins_and_review"):
        assert setting() == "listing_wins_and_review"
        raise RuntimeError("scénario en échec")

    assert setting() == DEFAULT_ON_LISTING_CHANGE
