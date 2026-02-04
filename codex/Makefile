.PHONY: help dev build start

help:
	@echo "Targets:"
	@echo "  dev    Run dev mode"
	@echo "  build  Build all packages from repo root"
	@echo "  start  Run built Codex service"

dev:
	npm run dev

build:
	cd .. && npm run build

start:
	node dist/index.js
