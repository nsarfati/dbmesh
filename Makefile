.PHONY: db-up db-down run test demo

db-up:
	docker compose up -d

db-down:
	docker compose down -v

run:
	go run ./cmd/dbmesh -config config.yaml

test:
	go test ./...

demo:
	psql "postgresql://dbmesh@localhost:6432/demo?sslmode=disable"
