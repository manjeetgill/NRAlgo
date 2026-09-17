"""Initial workspace schema. Frozen table definitions for repeatable deployments."""
from alembic import op
import sqlalchemy as sa
revision = '0001'
down_revision = None
branch_labels = None
depends_on = None


def upgrade():
    op.create_table('owners', sa.Column('id', sa.Integer, primary_key=True), sa.Column('username', sa.String(80), nullable=False, unique=True), sa.Column('password_hash', sa.Text, nullable=False), sa.Column('failed_logins', sa.Integer, nullable=False), sa.Column('locked_until', sa.Float, nullable=False))
    op.create_table('sessions', sa.Column('token_hash', sa.String(64), primary_key=True), sa.Column('csrf', sa.String(100), nullable=False), sa.Column('expires', sa.Float, nullable=False))
    op.create_table('settings', sa.Column('id', sa.Integer, primary_key=True), sa.Column('halted', sa.Boolean, nullable=False))
    op.create_table('strategies', sa.Column('id', sa.String(36), primary_key=True), sa.Column('name', sa.String(60), nullable=False), sa.Column('symbol', sa.String(20), nullable=False), sa.Column('fast', sa.Integer, nullable=False), sa.Column('slow', sa.Integer, nullable=False), sa.Column('capital', sa.Integer, nullable=False), sa.Column('status', sa.String(20), nullable=False), sa.Column('pnl', sa.Float, nullable=False), sa.Column('created_at', sa.String(40), nullable=False))
    op.create_table('jobs', sa.Column('id', sa.String(36), primary_key=True), sa.Column('strategy_id', sa.String(36), nullable=False), sa.Column('status', sa.String(20), nullable=False), sa.Column('result', sa.Text, nullable=False), sa.Column('created_at', sa.String(40), nullable=False), sa.Column('updated_at', sa.String(40), nullable=False))
    op.create_table('events', sa.Column('id', sa.Integer, primary_key=True, autoincrement=True), sa.Column('message', sa.Text, nullable=False), sa.Column('created_at', sa.String(40), nullable=False))


def downgrade():
    for name in ['events', 'jobs', 'strategies', 'settings', 'sessions', 'owners']:
        op.drop_table(name)
