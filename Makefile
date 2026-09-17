.PHONY: run check install build migrate deploy logs status stop
run:
	npm run dev
check:
	npm run check
install:
	npm ci --registry=https://registry.npmjs.org
	npm ci --prefix frontend --registry=https://registry.npmjs.org
build:
	npm run build
migrate:
	npm run migrate
deploy:
	docker info > /dev/null
	docker compose config --quiet
	docker compose build --pull
	docker compose run --rm --no-deps api node --input-type=module -e "import {createApp} from './backend/main.mjs'; createApp({}, process.env); console.log('Production configuration valid.');"
	docker compose up -d --wait --wait-timeout 180
logs:
	docker compose logs --tail=100 -f
stop:
	docker compose stop
status:
	docker compose ps
