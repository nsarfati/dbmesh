# Run from dashboard/front.
#
#   make run     # dev server on http://localhost:5173, proxying /api to the dashboard API
#   make test

# Where the dev server proxies /api; matches `make run` in dashboard/api.
DASHBOARD_API ?= http://127.0.0.1:8000

.PHONY: install run build test typecheck gen-api clean

# Reinstalls only when the dependency manifests change.
node_modules: package.json package-lock.json
	npm install
	@touch node_modules

install: node_modules

run: node_modules
	DASHBOARD_API=$(DASHBOARD_API) npm run dev

build: node_modules
	npm run build

test: node_modules
	npm test

typecheck: node_modules
	npm run typecheck

# Regenerate src/api/schema.d.ts after `make openapi` in dashboard/api.
gen-api: node_modules
	npm run gen:api

clean:
	rm -rf dist
