# Development shortcuts and explicit single-host deployment lifecycle commands.
.PHONY: run check install build migrate preflight deploy logs status stop db-start db-stop
db-start:
	node --env-file-if-exists=.env --import tsx backend/local-database.ts
db-stop:
	node --import tsx backend/local-database.ts --stop
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
preflight:
	npm run check:production
	docker info > /dev/null
	docker compose config --quiet
deploy:
	$(MAKE) preflight
	docker compose build --pull
	docker compose run --rm --no-deps api node --input-type=module -e "import {createApiApplication} from './dist/backend/main.js'; createApiApplication({}, process.env); console.log('Production configuration valid.');"
	docker compose up -d --wait --wait-timeout 180
	docker compose exec -T api node -e "fetch('http://127.0.0.1:8000/api/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
logs:
	docker compose logs --tail=100 -f
stop:
	docker compose stop
status:
	docker compose ps
