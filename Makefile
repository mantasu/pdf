default: help

UNAME := $(shell uname -s 2>/dev/null)

.PHONY: help
help: # Show help for each of the Makefile recipes
	@grep -E '^[a-zA-Z0-9_-]+:.*#' Makefile | awk 'BEGIN{FS=":.*# ?"} {n[NR]=$$1; d[NR]=$$2; if(length($$1)>m) m=length($$1)} END{for(i=1;i<=NR;i++) printf "\033[1;32m%-*s\033[0m  %s\n", m, n[i], d[i]}'

.PHONY: setup
setup: # Setup latest LTS Node.js then install dependencies
ifeq ($(UNAME),Darwin)
	brew install node 2>/dev/null || brew upgrade node
else ifeq ($(UNAME),Linux)
	sudo npm install -g n npm@latest && sudo n lts && hash -r
else
	$(error Windows: install Node.js LTS from https://nodejs.org then run 'make install')
endif
	npm install --no-audit --no-fund --loglevel=error

.PHONY: install
install: # Clean install all dependencies
	rm -rf node_modules package-lock.json
	npm install --no-audit --no-fund --loglevel=error

.PHONY: pdfjs
pdfjs: # Download and verify the pinned pdf.js distribution into resources/pdf.js
	bash scripts/download-pdfjs.sh

.PHONY: check
check: # Verify vendored pdf.js invariants
	node scripts/check-pdfjs.mjs

.PHONY: example
example: # Generate examples/example.pdf (needs 'npm install')
	node scripts/make-example.mjs

.PHONY: test
test: # Run unit tests with coverage
	npm test

.PHONY: clean
clean: # Remove all generated files (compiled output, coverage, extension packages)
	rm -rf out dist coverage *.vsix
