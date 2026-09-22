# Build and install the DBMesh Python client. Run from clients/python.
#
#   make install VENV=$HOME/code/other-repo/venv   # into another project's venv
#   make install-dev                                # editable, into this repo's venv
#
# VENV must already exist (python3 -m venv <path>). Use an absolute path or
# $HOME; the shell does not expand "~" inside VAR=~/path for every shell.

VENV   ?= ../../venv
EXTRAS ?= binary
PYTHON  = $(abspath $(VENV))/bin/python
EXTRA_SPEC = $(if $(EXTRAS),[$(EXTRAS)])

.PHONY: check-venv build install install-dev test clean

check-venv:
	@test -x "$(PYTHON)" || { echo "no virtualenv at $(VENV); create it with: python3 -m venv $(VENV)" >&2; exit 1; }

# Build a wheel into dist/.
build: check-venv
	rm -rf build dist
	$(PYTHON) -m pip wheel --no-deps --wheel-dir dist .

# Install the built wheel into VENV, replacing any previous version.
install: build
	-$(PYTHON) -m pip uninstall -y dbmesh-python-client
	$(PYTHON) -m pip install "$$(ls dist/*.whl)$(EXTRA_SPEC)"

# Editable install: source changes apply without reinstalling.
install-dev: check-venv
	$(PYTHON) -m pip install -e ".$(EXTRA_SPEC)"

test: check-venv
	$(PYTHON) -m unittest discover -s tests -v

clean:
	rm -rf build dist src/*.egg-info
