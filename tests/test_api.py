import importlib
import json
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from backend import database, main, worker
from backend.simulator import replay


@pytest.fixture
def client(tmp_path, monkeypatch):
    engine = create_engine(f'sqlite:///{tmp_path / "test.db"}', connect_args={'check_same_thread': False})
    database.Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    for module in [database, main, worker]:
        monkeypatch.setattr(module, 'Session', factory)
    monkeypatch.setattr(main, 'initialize', lambda: None)
    with factory.begin() as db:
        db.add(database.Settings(id=1, halted=False))
    with TestClient(main.app) as c:
        yield c
    engine.dispose()


def owner(client):
    r = client.post('/api/auth/setup', json={'username': 'testowner', 'password': 'test-password-long'})
    assert r.status_code == 200
    return {'X-CSRF-Token': r.json()['csrf']}


def strategy(client, headers, **overrides):
    return client.post('/api/strategies', headers=headers, json={
        'name': 'Momentum test', 'symbol': 'NIFTY', 'capital': 100000, 'fast': 9, 'slow': 21, **overrides,
    })


def test_auth_and_csrf(client):
    assert client.get('/api/workspace').status_code == 401
    headers = owner(client)
    assert client.get('/api/auth/status').json()['setup_required'] is False
    assert client.post('/api/auth/setup', json={'username': 'intruder', 'password': 'another-long-password'}).status_code == 409
    assert strategy(client, {}).status_code == 403
    assert strategy(client, headers).status_code == 201
    assert client.post('/api/controls', headers={**headers, 'origin': 'https://evil.example'}, json={'halted': True}).status_code == 403
    assert client.post('/api/auth/logout', headers=headers).status_code == 200
    assert client.get('/api/workspace').status_code == 401


def test_validation_and_live_disabled(client):
    headers = owner(client)
    for override in [{'fast': 30, 'slow': 10}, {'capital': -5}, {'capital': 500001}, {'mode': 'live'}, {'name': '  '}]:
        assert strategy(client, headers, **override).status_code == 422


def test_replay_end_to_end_and_duplicate_prevention(client):
    headers = owner(client)
    identifier = strategy(client, headers).json()['id']
    assert client.post(f'/api/strategies/{identifier}/run', headers=headers).status_code == 202
    assert client.post(f'/api/strategies/{identifier}/run', headers=headers).status_code == 409
    assert worker.process_one()
    data = client.get('/api/workspace').json()
    assert data['strategies'][0]['status'] == 'ready'
    result = data['jobs'][0]['result']
    assert data['jobs'][0]['status'] == 'completed'
    assert len(result['equity']) == 240
    assert result['trades']
    assert result['source'] == 'synthetic'
    assert round(sum(t['pnl'] or 0 for t in result['trades']), 2) == pytest.approx(result['pnl'], abs=.02)
    assert worker.process_one() is False
    # A new client can authenticate and retrieve the same persisted strategy.
    client.cookies.clear()
    assert client.post('/api/auth/login', json={'username': 'testowner', 'password': 'test-password-long'}).status_code == 200
    assert client.get('/api/workspace').json()['strategies'][0]['id'] == identifier


def test_pause_blocks_and_cancels(client):
    headers = owner(client)
    identifier = strategy(client, headers).json()['id']
    client.post(f'/api/strategies/{identifier}/run', headers=headers)
    assert client.post('/api/controls', headers=headers, json={'halted': True}).status_code == 200
    assert worker.process_one() is False
    assert client.get('/api/workspace').json()['jobs'][0]['status'] == 'cancelled'
    assert client.post(f'/api/strategies/{identifier}/run', headers=headers).status_code == 409
    client.post('/api/controls', headers=headers, json={'halted': False})
    assert client.post(f'/api/strategies/{identifier}/run', headers=headers).status_code == 202


def test_login_throttle_and_password_hash(client):
    owner(client)
    with database.Session() as db:
        assert 'test-password-long' not in db.get(database.Owner, 1).password_hash
    for _ in range(5):
        assert client.post('/api/auth/login', json={'username': 'testowner', 'password': 'wrong-password-long'}).status_code == 401
    assert client.post('/api/auth/login', json={'username': 'testowner', 'password': 'test-password-long'}).status_code == 429


def test_replay_has_no_unfunded_positions():
    result = replay('SENSEX', 1000, 9, 21)
    assert result['trades'] == []
    assert result['pnl'] == 0
    assert result == replay('SENSEX', 1000, 9, 21)
