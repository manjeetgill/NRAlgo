"""Run one worker with python -m backend.worker. Database-backed paper replay queue."""
import json
import time
from sqlalchemy import select, update
from .database import Session, Job, Strategy, Settings, audit, initialize, now
from .simulator import replay


def process_one():
    with Session.begin() as db:
        if db.get(Settings, 1).halted:
            return False
        job = db.scalars(select(Job).where(Job.status == 'queued').order_by(Job.created_at)).first()
        if not job:
            return False
        claimed = db.execute(update(Job).where(Job.id == job.id, Job.status == 'queued').values(status='running', updated_at=now()))
        if claimed.rowcount != 1:
            return False
        strategy = db.get(Strategy, job.strategy_id)
        strategy.status = 'running'
        identifier, sid = job.id, strategy.id
        args = (strategy.symbol, strategy.capital, strategy.fast, strategy.slow)
    try:
        result = replay(*args)
        with Session.begin() as db:
            # Lock the same control row as pause-all before committing a result.
            settings = db.execute(select(Settings).where(Settings.id == 1).with_for_update()).scalar_one()
            job = db.get(Job, identifier)
            if settings.halted or job.status != 'running':
                return True
            job.status, job.result, job.updated_at = 'completed', json.dumps(result), now()
            strategy = db.get(Strategy, sid)
            strategy.status, strategy.pnl = 'ready', result['pnl']
            audit(db, f'Completed sample-data replay: {strategy.name}. {len(result["trades"])} simulated fills.')
    except Exception:
        with Session.begin() as db:
            job = db.get(Job, identifier)
            if job.status == 'running':
                job.status = 'failed'
                db.get(Strategy, sid).status = 'failed'
                audit(db, 'Paper replay failed. Check worker logs and retry.')
        import logging
        logging.exception('Paper replay failed')
    return True


if __name__ == '__main__':
    initialize()
    # This MVP supports a single worker. Requeue unfinished work after a restart.
    with Session.begin() as db:
        db.execute(update(Job).where(Job.status == 'running').values(status='queued'))
        db.execute(update(Strategy).where(Strategy.status == 'running').values(status='queued'))
    print('Paper replay worker ready.', flush=True)
    while True:
        if not process_one():
            time.sleep(1)
