.PHONY: build clean test claude-test codex-test

JOBS ?= 4

build:
	npm run build

clean:
	rm -rf slack/dist claude/dist codex/dist opencode/dist

test:
	npm run test -- --maxWorkers=$(JOBS)

claude-test:
	npm run test:claude -- --maxWorkers=$(JOBS)

codex-test:
	npm run test:codex -- --maxWorkers=$(JOBS)
