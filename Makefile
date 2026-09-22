.PHONY: db-up db-down run test demo dashboard dashboard-api dashboard-front dashboard-build dashboard-test

db-up:
	docker compose up -d

db-down:
	docker compose down -v

run:
	go run ./cmd/dbmesh -config config_proxy.yaml

test:
	go test ./...

demo:
	psql "postgresql://dbmesh@localhost:6432/demo?sslmode=disable"

# The dashboard (see dashboard/README.md). DBMesh must be running for it to have data: `make run`.

# One process: build the front end and let the API serve it on http://127.0.0.1:8000.
dashboard: dashboard-build dashboard-api

# Development: run these two in separate terminals; the front end reloads on change.
dashboard-api:
	$(MAKE) -C dashboard/api run

dashboard-front:
	$(MAKE) -C dashboard/front run

dashboard-build:
	$(MAKE) -C dashboard/front build

dashboard-test:
	$(MAKE) -C dashboard/api test
	$(MAKE) -C dashboard/front test
