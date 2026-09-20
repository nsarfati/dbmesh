.PHONY: db-up db-down run test demo

db-up:
	docker compose up -d

db-down:
	docker compose down -v

run:
	set -a; . ./.env; set +a; go run ./cmd/dbmesh

test:
	go test ./...

demo:
	psql "postgresql://routepg@localhost:6432/demo?sslmode=disable"
