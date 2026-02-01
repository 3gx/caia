.PHONY: build clean test claude-test codex-test

build:
	npm run build

clean:
	rm -rf slack/dist claude/dist codex/dist opencode/dist

test:
	npm run test

claude-test:
	npm run test:claude

codex-test:
	npm run test:codex
