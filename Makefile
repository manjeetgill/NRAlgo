.PHONY: run check install build migrate
run:
	.venv/bin/python run.py
check:
	.venv/bin/python -m pytest -q
	npm --prefix frontend run typecheck
install:
	python3 -m venv .venv
	.venv/bin/python -m pip install -r requirements.txt
	npm ci --prefix frontend --registry=https://registry.npmjs.org
build:
	npm --prefix frontend run build
migrate:
	.venv/bin/alembic upgrade head
