from __future__ import annotations

import os
from contextlib import contextmanager
from copy import deepcopy
from datetime import UTC, datetime, timedelta

import pytest
from psycopg.types.json import Jsonb

from src import source_detail_reuse as reuse
from src import source_detail_worker as worker
from src.freshness import SOURCE_EXTRACTION_VERSION
from src.models import AuctionSale

NOW = datetime(2026, 9, 29, 20, tzinfo=UTC)
ALIAS = 'https://www.licitor.com/annonce/alias'
CANONICAL = 'https://catalogue.example/sale'


def _proof(now=NOW):
    job = {'id': 'job', 'source_url': CANONICAL, 'job_type': 'source_detail',
           'detail_source_name': 'licitor', 'detail_source_url': ALIAS,
           'attempt_count': 1, 'locked_at': now, 'created_at': now-timedelta(hours=3)}
    payload = {'source_checks': {ALIAS: {'source_name': 'licitor',
               'extractor_version': SOURCE_EXTRACTION_VERSION, 'fingerprint': 'verified',
               'checked_at': (now-timedelta(hours=1)).isoformat(), 'detail_status': 'complete'}}}
    return job, payload


@pytest.mark.parametrize('case', ['valid', 'restricted', 'listing', 'old_version', 'other_source',
                                 'other_alias', 'before_job', 'future', 'naive', 'missing_fingerprint',
                                 'quarantined', 'identity_conflict', 'boundary_5h', 'boundary_23h'])
def test_only_newer_verified_exact_alias_can_satisfy_recurring_job(case):
    job, payload = _proof()
    check = payload['source_checks'][ALIAS]
    date, status = NOW+timedelta(days=2), 'upcoming'
    if case == 'restricted':
        check['detail_status'] = 'restricted'
    elif case == 'listing':
        check.pop('detail_status')
    elif case == 'old_version':
        check['extractor_version'] = 'old'
    elif case == 'other_source':
        check['source_name'] = 'vench'
    elif case == 'other_alias':
        job['detail_source_url'] = ALIAS+'-other'
    elif case == 'before_job':
        check['checked_at'] = job['created_at'].isoformat()
    elif case == 'future':
        check['checked_at'] = (NOW+timedelta(seconds=1)).isoformat()
    elif case == 'naive':
        check['checked_at'] = '2026-09-29T19:00:00'
    elif case == 'missing_fingerprint':
        check.pop('fingerprint')
    elif case == 'quarantined':
        status = 'quarantined'
    elif case == 'identity_conflict':
        payload['publication_identity_conflict'] = {'reason': 'other property'}
    elif case in {'boundary_5h', 'boundary_23h'}:
        hours = 5 if case == 'boundary_5h' else 23
        date = NOW+timedelta(days=2 if hours == 5 else 8)
        job['created_at'] = NOW-timedelta(hours=hours+1)
        check['checked_at'] = (NOW-timedelta(hours=hours)).isoformat()
    assert reuse.verified_detail_satisfies_job(payload, date, status, job, now=NOW) is (case in {'valid', 'restricted'})


@pytest.mark.parametrize('completion', [True, False])
def test_verified_noop_or_lost_lease_does_not_fetch_or_publish(monkeypatch, completion):
    job, payload = _proof()
    sale = AuctionSale(source_name='licitor', source_url=CANONICAL, raw_payload=payload)
    monkeypatch.setattr(worker, 'source_detail_source_enabled', lambda *args: True)
    monkeypatch.setattr(worker, 'fetch_sale_for_data_refresh', lambda *args: sale)
    monkeypatch.setattr(worker, 'complete_already_verified_detail_job', lambda *args: completion)
    monkeypatch.setattr(worker, 'fetch_public_detail', lambda *args: pytest.fail('Already verified detail must not issue HTTP'))
    monkeypatch.setattr(worker, 'publish_source_revision', lambda *args: pytest.fail('No new catalogue revision'))
    monkeypatch.setattr(worker, '_finish_job', lambda *args, **kwargs: pytest.fail('Owned completion must not be finished twice'))
    assert worker.process_source_detail_job(job, settings={'supabase_db_url': None}) is completion


@pytest.mark.parametrize('scenario', ['current', 'reclaimed', 'expired', 'other_alias', 'changed_proof', 'deleted'])
def test_noop_rechecks_locked_catalogue_and_exact_lease(monkeypatch, scenario):
    url = os.getenv('PIPELINE_TEST_DB_URL')
    if not url:
        pytest.skip('Requires disposable PostgreSQL')
    with reuse.storage._postgres_connect(url) as db:
        try:
            db.execute('create table auction_sales(source_url text primary key,raw_payload jsonb,sale_date timestamptz,status text)')
            db.execute('''create table auction_enrichment_jobs(id text primary key,source_url text,job_type text,
                detail_source_name text,detail_source_url text,status text,attempt_count int,locked_at timestamptz,
                created_at timestamptz,last_error text,completed_at timestamptz,updated_at timestamptz)''')
            now = db.execute('select now()').fetchone()[0]
            job, payload = _proof(now)
            sale = AuctionSale(source_name='licitor', source_url=CANONICAL, raw_payload=deepcopy(payload),
                               sale_date=now+timedelta(days=2), status='upcoming')
            db.execute('insert into auction_sales values(%s,%s,%s,%s)', (CANONICAL, Jsonb(payload), sale.sale_date, sale.status))
            db.execute("""insert into auction_enrichment_jobs(id,source_url,job_type,detail_source_name,detail_source_url,
                status,attempt_count,locked_at,created_at) values('job',%s,'source_detail','licitor',%s,'running',1,%s,%s)""",
                (CANONICAL, ALIAS, now, job['created_at']))
            if scenario == 'reclaimed':
                db.execute('update auction_enrichment_jobs set attempt_count=2')
            elif scenario == 'expired':
                job['locked_at'] = now-timedelta(minutes=31)
                db.execute('update auction_enrichment_jobs set locked_at=%s', (job['locked_at'],))
            elif scenario == 'other_alias':
                db.execute("update auction_enrichment_jobs set detail_source_url=detail_source_url||'-other'")
            elif scenario == 'changed_proof':
                payload['source_checks'][ALIAS].pop('detail_status')
                db.execute('update auction_sales set raw_payload=%s', (Jsonb(payload),))
            elif scenario == 'deleted':
                db.execute('delete from auction_sales')

            @contextmanager
            def connect(_, **kwargs):
                assert kwargs == {'connect_timeout': 3, 'retry_delays': ()}
                with db.transaction():
                    yield db

            monkeypatch.setattr(reuse.storage, '_postgres_connect', connect)
            result = reuse.complete_already_verified_detail_job(sale, job, {'supabase_db_url': url})
            assert result is (True if scenario == 'current' else None if scenario in {'changed_proof', 'deleted'} else False)
            state = db.execute('select status,attempt_count from auction_enrichment_jobs').fetchone()
            expected_state = ('completed', 0) if scenario == 'current' else ('running', 2 if scenario == 'reclaimed' else 1)
            assert state == expected_state
        finally:
            db.rollback()
