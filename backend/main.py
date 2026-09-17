"""Authenticated single-owner API. Live broker execution is not implemented."""
import hashlib
import json
import os
import secrets
import time
from contextlib import asynccontextmanager
from typing import Literal
from uuid import uuid4

from fastapi import FastAPI, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import select, update, delete
from sqlalchemy.exc import IntegrityError

from .database import Session, Owner, LoginSession, Strategy, Job, Event, Settings, audit, initialize

PRODUCTION = os.getenv('APP_ENV') == 'production'
ORIGIN = os.getenv('APP_ORIGIN', 'http://localhost:3000')
SETUP_TOKEN = os.getenv('SETUP_TOKEN', '')
if PRODUCTION and (not ORIGIN.startswith('https://') or len(SETUP_TOKEN) < 32):
    raise RuntimeError('Production requires HTTPS APP_ORIGIN and a random SETUP_TOKEN of at least 32 characters.')


@asynccontextmanager
async def lifespan(app):
    initialize()
    yield


app = FastAPI(title='Nexus Algo API', version='0.3.0', lifespan=lifespan,
              docs_url=None if PRODUCTION else '/api/docs', openapi_url='/api/openapi.json' if not PRODUCTION else None)


def error(message, status=400):
    raise HTTPException(status, message)


@app.middleware('http')
async def security_headers(request: Request, call_next):
    if request.method not in ('GET', 'HEAD', 'OPTIONS'):
        origin = request.headers.get('origin')
        if origin and origin not in ({ORIGIN} if PRODUCTION else {ORIGIN, 'http://127.0.0.1:3000'}):
            return Response('Origin not allowed', status_code=403)
        length = request.headers.get('content-length', '0')
        if not length.isdigit() or int(length) > 16384:
            return Response('Request too large', status_code=413)
    response = await call_next(request)
    response.headers['Cache-Control'] = 'no-store'
    response.headers['X-Content-Type-Options'] = 'nosniff'
    return response


def require_owner(request: Request):
    raw = request.cookies.get('nexus_session', '')
    token_hash = hashlib.sha256(raw.encode()).hexdigest()
    with Session() as db:
        session = db.get(LoginSession, token_hash)
        if not session or session.expires < time.time():
            error('Please sign in.', 401)
        if request.method != 'GET' and not secrets.compare_digest(request.headers.get('x-csrf-token', ''), session.csrf):
            error('Session verification failed. Refresh and try again.', 403)
        return session


class Credentials(BaseModel):
    username: str = Field(min_length=3, max_length=80, pattern=r'^[a-zA-Z0-9_.@-]+$')
    password: str = Field(min_length=12, max_length=128)
    setup_token: str = Field(default='', max_length=200)


def hash_password(password, salt=None):
    salt = salt or secrets.token_hex(16)
    digest = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1).hex()
    return salt + ':' + digest


def issue_session(response, db):
    raw = secrets.token_urlsafe(48)
    csrf = secrets.token_urlsafe(32)
    db.execute(delete(LoginSession).where(LoginSession.expires < time.time()))
    db.add(LoginSession(token_hash=hashlib.sha256(raw.encode()).hexdigest(), csrf=csrf, expires=time.time() + 28800))
    response.set_cookie('nexus_session', raw, httponly=True, secure=PRODUCTION, samesite='strict', max_age=28800, path='/')
    return {'csrf': csrf}


@app.get('/api/health')
def health():
    return {'status': 'ok', 'service': 'nexus-fastapi', 'live_enabled': False}


@app.get('/api/auth/status')
def auth_status():
    with Session() as db:
        return {'setup_required': db.get(Owner, 1) is None, 'setup_token_required': bool(SETUP_TOKEN)}


@app.post('/api/auth/setup')
def setup(data: Credentials, response: Response):
    if SETUP_TOKEN and not secrets.compare_digest(data.setup_token, SETUP_TOKEN):
        error('Invalid setup token.', 403)
    try:
        with Session.begin() as db:
            if db.get(Owner, 1):
                error('Workspace already configured.', 409)
            db.add(Owner(id=1, username=data.username, password_hash=hash_password(data.password)))
            audit(db, 'Owner account created. Paper workspace initialized.')
            return issue_session(response, db)
    except IntegrityError:
        error('Workspace already configured.', 409)


@app.post('/api/auth/login')
def login(data: Credentials, response: Response):
    with Session.begin() as db:
        owner = db.execute(select(Owner).where(Owner.id == 1).with_for_update()).scalar_one_or_none()
        if not owner:
            error('Create the workspace first.', 409)
        if owner.locked_until > time.time():
            error('Too many attempts. Try again in a minute.', 429)
        valid = secrets.compare_digest(hash_password(data.password, owner.password_hash.split(':')[0]), owner.password_hash)
        valid = valid and secrets.compare_digest(data.username, owner.username)
        if valid:
            owner.failed_logins = 0
            audit(db, 'Owner signed in.')
            result = issue_session(response, db)
        else:
            owner.failed_logins += 1
            if owner.failed_logins >= 5:
                owner.locked_until = time.time() + 60
                owner.failed_logins = 0
    if not valid:
        error('Incorrect username or password.', 401)
    return result


@app.post('/api/auth/logout')
def logout(response: Response, session=Depends(require_owner)):
    with Session.begin() as db:
        db.execute(delete(LoginSession).where(LoginSession.token_hash == session.token_hash))
    response.delete_cookie('nexus_session', path='/')
    return {'ok': True}


class StrategyInput(BaseModel):
    name: str = Field(min_length=2, max_length=60)
    symbol: Literal['NIFTY', 'BANKNIFTY', 'SENSEX'] = 'NIFTY'
    capital: int = Field(ge=1000, le=500000, strict=True)
    fast: int = Field(default=9, ge=2, le=40, strict=True)
    slow: int = Field(default=21, ge=3, le=80, strict=True)
    mode: Literal['paper'] = 'paper'

    @model_validator(mode='after')
    def validate_periods(self):
        self.name = self.name.strip()
        if len(self.name) < 2 or self.fast >= self.slow:
            raise ValueError('Use a valid name and a fast EMA shorter than the slow EMA.')
        return self


@app.get('/api/workspace')
def workspace(session=Depends(require_owner)):
    with Session() as db:
        strategies = db.scalars(select(Strategy).order_by(Strategy.created_at.desc())).all()
        jobs = db.scalars(select(Job).order_by(Job.created_at.desc()).limit(30)).all()
        events = db.scalars(select(Event).order_by(Event.id.desc()).limit(50)).all()
        return {
            'username': db.get(Owner, 1).username, 'csrf': session.csrf,
            'halted': db.get(Settings, 1).halted,
            'strategies': [{key: getattr(s, key) for key in ('id', 'name', 'symbol', 'fast', 'slow', 'capital', 'status', 'pnl')} for s in strategies],
            'jobs': [{'id': j.id, 'strategy_id': j.strategy_id, 'status': j.status, 'created_at': j.created_at, 'result': json.loads(j.result)} for j in jobs],
            'events': [{'id': e.id, 'message': e.message, 'created_at': e.created_at} for e in events],
        }


@app.post('/api/strategies', status_code=201)
def create_strategy(data: StrategyInput, session=Depends(require_owner)):
    identifier = str(uuid4())
    with Session.begin() as db:
        db.add(Strategy(id=identifier, **data.model_dump(exclude={'mode'})))
        audit(db, f'Created strategy: {data.name} · {data.symbol} · EMA {data.fast}/{data.slow}.')
    return {'id': identifier}


@app.post('/api/strategies/{identifier}/run', status_code=202)
def run_strategy(identifier: str, session=Depends(require_owner)):
    with Session.begin() as db:
        settings = db.execute(select(Settings).where(Settings.id == 1).with_for_update()).scalar_one()
        if settings.halted:
            error('Workspace is paused. Resume before starting a replay.', 409)
        changed = db.execute(update(Strategy).where(Strategy.id == identifier, Strategy.status != 'queued', Strategy.status != 'running').values(status='queued'))
        if changed.rowcount != 1:
            error('Strategy not found or already queued/running.', 409)
        job = Job(id=str(uuid4()), strategy_id=identifier)
        db.add(job)
        audit(db, 'Queued sample-data replay for ' + db.get(Strategy, identifier).name + '.')
    return {'id': job.id}


class HaltInput(BaseModel):
    halted: bool


@app.post('/api/controls')
def controls(data: HaltInput, session=Depends(require_owner)):
    with Session.begin() as db:
        settings = db.execute(select(Settings).where(Settings.id == 1).with_for_update()).scalar_one()
        settings.halted = data.halted
        if data.halted:
            db.execute(update(Job).where(Job.status.in_(['queued', 'running'])).values(status='cancelled'))
            db.execute(update(Strategy).where(Strategy.status.in_(['queued', 'running'])).values(status='paused'))
        audit(db, 'Paused all paper work. Pending replays cancelled.' if data.halted else 'Paper workspace resumed.')
    return {'ok': True}
