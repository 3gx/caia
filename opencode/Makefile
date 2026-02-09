.PHONY: help dev build start ensure-dist-fresh

help:
	@echo "Targets:"
	@echo "  dev    Run dev mode"
	@echo "  build  Build all packages from repo root"
	@echo "  start  Run built OpenCode service"

dev:
	npm run dev

build:
	cd .. && npm run build

start:
	@$(MAKE) ensure-dist-fresh
	node dist/index.js

ensure-dist-fresh:
	@if [ ! -f dist/index.js ]; then \
		echo "[opencode] dist missing; running build"; \
		$(MAKE) build; \
	elif find src -type f -newer dist/index.js | grep -q .; then \
		echo "[opencode] src is newer than dist; rebuilding"; \
		$(MAKE) build; \
	else \
		echo "[opencode] dist is up to date"; \
	fi
