# Run from dashboard/api.
#
#   make run     # API on http://127.0.0.1:8000, configured from ../../config.yaml
#   make test

VENV          ?= .venv
PYTHON        := $(VENV)/bin/python
DBMESH_CONFIG ?= $(abspath ../../config.yaml)

.PHONY: install run test openapi clean

$(PYTHON):
	python3 -m venv $(VENV)

install: $(PYTHON)
	$(PYTHON) -m pip install -e ../../clients/python -e '.[test]'

run: install
	DBMESH_CONFIG=$(DBMESH_CONFIG) $(PYTHON) -m dbmesh_dashboard

# Integration tests run when DBMESH_TEST_AUDIT_URL is set (they use a throwaway database).
test: install
	$(PYTHON) -m pytest -q

# Regenerate openapi.json, the contract the front generates its types from.
openapi: install
	$(PYTHON) -m dbmesh_dashboard.openapi > openapi.json

clean:
	rm -rf build src/*.egg-info .pytest_cache
