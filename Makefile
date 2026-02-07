.PHONY: help setup setup-tools verify-tools build clean test sdk-test claude-test codex-test opencode-test claude-sdk-test codex-sdk-test opencode-sdk-test claude-dev codex-dev opencode-dev claude-start codex-start opencode-start

JOBS ?= 4

help:
	@echo "Setup Targets:"
	@echo "  setup              Install npm dependencies"
	@echo "  setup-tools        Install native dependencies (Puppeteer, Sharp)"
	@echo "  verify-tools       Verify all dependencies are installed"
	@echo ""
	@echo "Build Targets:"
	@echo "  build              Build claude/codex/opencode packages"
	@echo "  clean              Remove build artifacts"
	@echo ""
	@echo "Test Targets:"
	@echo "  test               Run unit + integration tests"
	@echo "  sdk-test           Run live SDK tests for all providers"
	@echo "  claude-test        Run Claude unit + integration tests"
	@echo "  codex-test         Run Codex unit + integration tests"
	@echo "  opencode-test      Run OpenCode unit + integration tests"
	@echo "  claude-sdk-test    Run Claude live SDK tests"
	@echo "  codex-sdk-test     Run Codex live SDK tests"
	@echo "  opencode-sdk-test  Run OpenCode live SDK tests"
	@echo ""
	@echo "Run a Provider:"
	@echo "  claude-dev         Run Claude bot in dev mode"
	@echo "  codex-dev          Run Codex bot in dev mode"
	@echo "  opencode-dev       Run OpenCode bot in dev mode"
	@echo "  claude-start       Build and run Claude bot"
	@echo "  codex-start        Build and run Codex bot"
	@echo "  opencode-start     Build and run OpenCode bot"
	@echo ""
	@echo "Or manually: cd claude/ && make build && make start"

# =============================================================================
# Setup Targets
# =============================================================================

setup:
	@echo "=== Installing npm dependencies ==="
	@if ! command -v node >/dev/null 2>&1; then \
		echo ""; \
		echo "ERROR: Node.js is not installed."; \
		echo ""; \
		echo "Please install Node.js 18+ first:"; \
		echo ""; \
		if [ "$$(uname)" = "Darwin" ]; then \
			echo "  Option 1 (Homebrew):"; \
			echo "    brew install node"; \
			echo ""; \
			echo "  Option 2 (nvm - recommended):"; \
			echo "    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash"; \
			echo "    nvm install 22"; \
			echo ""; \
			echo "  Option 3 (Direct download):"; \
			echo "    https://nodejs.org/en/download/"; \
		else \
			echo "  Option 1 (nvm - recommended):"; \
			echo "    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash"; \
			echo "    nvm install 22"; \
			echo ""; \
			echo "  Option 2 (NodeSource):"; \
			echo "    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -"; \
			echo "    sudo apt-get install -y nodejs"; \
			echo ""; \
			echo "  Option 3 (Direct download):"; \
			echo "    https://nodejs.org/en/download/"; \
		fi; \
		echo ""; \
		exit 1; \
	fi
	@if ! command -v npm >/dev/null 2>&1; then \
		echo ""; \
		echo "ERROR: npm is not installed."; \
		echo "npm usually comes with Node.js. Please reinstall Node.js."; \
		echo ""; \
		exit 1; \
	fi
	@echo "Node.js: $$(node --version)"
	@echo "npm: $$(npm --version)"
	@echo ""
	npm install
	@echo ""
	@echo "=== npm dependencies installed successfully ==="
	@echo ""
	@echo "Next steps:"
	@echo "  1. Run 'make setup-tools' to install native dependencies"
	@echo "  2. Run 'make verify-tools' to verify installation"
	@echo "  3. Run 'make build' to build the project"

setup-tools:
	@echo "=== Installing native dependencies ==="
	@echo "Detecting OS..."
	@if [ "$$(uname)" = "Darwin" ]; then \
		echo ""; \
		echo "macOS detected"; \
		echo ""; \
		echo "Puppeteer will auto-download Chromium on first use."; \
		echo "Sharp binaries are included in the npm package."; \
		echo ""; \
		echo "No additional setup required on macOS."; \
		echo ""; \
		if command -v brew >/dev/null 2>&1; then \
			echo "Homebrew detected. If you encounter Chromium issues, you can run:"; \
			echo "  brew install --cask chromium"; \
		else \
			echo "Note: Homebrew is not installed (optional)."; \
			echo "If you encounter issues, install Homebrew from https://brew.sh"; \
			echo "Then run: brew install --cask chromium"; \
		fi; \
		echo ""; \
	elif [ -f /etc/os-release ]; then \
		. /etc/os-release; \
		if [ "$$ID" = "ubuntu" ] || [ "$$ID" = "debian" ]; then \
			echo ""; \
			echo "$$ID $$VERSION_ID detected"; \
			echo ""; \
			echo "Installing Chromium dependencies for Puppeteer..."; \
			echo ""; \
			if [ "$$(echo $$VERSION_ID | cut -d. -f1)" -ge 24 ] 2>/dev/null; then \
				echo "Using Ubuntu 24.04+ package names (libasound2t64)..."; \
				sudo apt-get update && sudo apt-get install -y \
					libx11-xcb1 libxcomposite1 libxcursor1 libxdamage1 libxi6 libxtst6 \
					libnss3 libnspr4 libcups2 libxss1 libxrandr2 libasound2t64 libatk1.0-0 \
					libatk-bridge2.0-0 libgtk-3-0 libgbm1 libpango-1.0-0 libpangocairo-1.0-0 \
					libcairo2 libfontconfig1 libdbus-1-3 libexpat1 libglib2.0-0; \
			else \
				echo "Using Ubuntu 22.04 and earlier package names (libasound2)..."; \
				sudo apt-get update && sudo apt-get install -y \
					libx11-xcb1 libxcomposite1 libxcursor1 libxdamage1 libxi6 libxtst6 \
					libnss3 libnspr4 libcups2 libxss1 libxrandr2 libasound2 libatk1.0-0 \
					libatk-bridge2.0-0 libgtk-3-0 libgbm1 libpango-1.0-0 libpangocairo-1.0-0 \
					libcairo2 libfontconfig1 libdbus-1-3 libexpat1 libglib2.0-0; \
			fi; \
			echo ""; \
			echo "Linux dependencies installed successfully."; \
		elif [ "$$ID" = "fedora" ] || [ "$$ID" = "rhel" ] || [ "$$ID" = "centos" ]; then \
			echo ""; \
			echo "$$ID $$VERSION_ID detected"; \
			echo ""; \
			echo "Installing Chromium dependencies for Puppeteer..."; \
			sudo dnf install -y \
				libX11-xcb libXcomposite libXcursor libXdamage libXi libXtst \
				nss nspr cups-libs libXScrnSaver libXrandr alsa-lib atk \
				at-spi2-atk gtk3 libgbm pango cairo fontconfig dbus-libs \
				expat glib2 || \
			sudo yum install -y \
				libX11-xcb libXcomposite libXcursor libXdamage libXi libXtst \
				nss nspr cups-libs libXScrnSaver libXrandr alsa-lib atk \
				at-spi2-atk gtk3 libgbm pango cairo fontconfig dbus-libs \
				expat glib2; \
			echo ""; \
			echo "Linux dependencies installed successfully."; \
		else \
			echo ""; \
			echo "Unsupported Linux distribution: $$ID $$VERSION_ID"; \
			echo ""; \
			echo "Please install Chromium/Puppeteer dependencies manually."; \
			echo "Required libraries:"; \
			echo "  - X11/XCB libraries (libx11-xcb, libxcomposite, etc.)"; \
			echo "  - NSS and NSPR libraries"; \
			echo "  - GTK3 and related UI libraries"; \
			echo "  - ALSA sound library"; \
			echo ""; \
			echo "See: https://pptr.dev/troubleshooting#chrome-doesnt-launch-on-linux"; \
			echo ""; \
			exit 1; \
		fi; \
	else \
		echo ""; \
		echo "Unknown OS. Cannot detect package manager."; \
		echo ""; \
		echo "Please install Chromium dependencies manually for Puppeteer."; \
		echo "See: https://pptr.dev/troubleshooting"; \
		echo ""; \
		exit 1; \
	fi
	@echo ""
	@echo "=== Native dependency setup complete ==="
	@echo ""
	@echo "Run 'make verify-tools' to verify installation."

verify-tools:
	@echo "=== Verifying dependencies ==="
	@echo ""
	@ERRORS=0; \
	\
	echo "1. Checking Node.js..."; \
	if command -v node >/dev/null 2>&1; then \
		NODE_VERSION=$$(node --version); \
		NODE_MAJOR=$$(echo $$NODE_VERSION | sed 's/v//' | cut -d. -f1); \
		echo "   Found: $$NODE_VERSION"; \
		if [ "$$NODE_MAJOR" -lt 18 ]; then \
			echo "   WARNING: Node.js 18+ recommended (found $$NODE_VERSION)"; \
		else \
			echo "   OK"; \
		fi; \
	else \
		echo "   ERROR: Node.js not found"; \
		echo "   Run 'make setup' for installation instructions."; \
		ERRORS=1; \
	fi; \
	echo ""; \
	\
	echo "2. Checking npm..."; \
	if command -v npm >/dev/null 2>&1; then \
		echo "   Found: $$(npm --version)"; \
		echo "   OK"; \
	else \
		echo "   ERROR: npm not found"; \
		echo "   npm usually comes with Node.js. Please reinstall Node.js."; \
		ERRORS=1; \
	fi; \
	echo ""; \
	\
	echo "3. Checking TypeScript..."; \
	if [ -f node_modules/.bin/tsc ]; then \
		echo "   Found: $$(node_modules/.bin/tsc --version)"; \
		echo "   OK"; \
	elif command -v tsc >/dev/null 2>&1; then \
		echo "   Found (global): $$(tsc --version)"; \
		echo "   OK"; \
	else \
		echo "   Not installed (run 'make setup' first)"; \
	fi; \
	echo ""; \
	\
	echo "4. Checking npm dependencies..."; \
	if [ -d node_modules ]; then \
		echo "   node_modules exists"; \
		echo "   OK"; \
	else \
		echo "   node_modules not found"; \
		echo "   Run 'make setup' to install dependencies."; \
	fi; \
	echo ""; \
	\
	echo "5. Checking Puppeteer Chromium..."; \
	if [ "$$(uname)" = "Darwin" ]; then \
		CHROME_PATH=$$(find ~/.cache/puppeteer -name "Google Chrome for Testing.app" -type d 2>/dev/null | head -1); \
		if [ -z "$$CHROME_PATH" ]; then \
			echo "   Chromium not yet downloaded"; \
			echo "   (Will download automatically on first use after 'npm install')"; \
		else \
			echo "   Found: $$CHROME_PATH"; \
			echo "   OK"; \
		fi; \
	else \
		CHROME_PATH=$$(find ~/.cache/puppeteer -name "chrome" -type f -executable 2>/dev/null | head -1); \
		if [ -z "$$CHROME_PATH" ]; then \
			echo "   Chromium not yet downloaded"; \
			echo "   (Will download automatically on first use after 'npm install')"; \
		else \
			echo "   Found: $$CHROME_PATH"; \
			MISSING=$$(ldd "$$CHROME_PATH" 2>/dev/null | grep "not found" || true); \
			if [ -n "$$MISSING" ]; then \
				echo "   ERROR: Missing shared libraries:"; \
				echo "$$MISSING" | sed 's/^/      /'; \
				echo "   Run 'make setup-tools' to install missing dependencies."; \
				ERRORS=1; \
			else \
				echo "   All Chromium dependencies satisfied"; \
				echo "   OK"; \
			fi; \
		fi; \
	fi; \
	echo ""; \
	\
	echo "6. Checking Sharp..."; \
	if node -e "require('sharp')" 2>/dev/null; then \
		SHARP_VERSION=$$(node -e "console.log(require('sharp/package.json').version)" 2>/dev/null || echo "unknown"); \
		echo "   Found: $$SHARP_VERSION"; \
		echo "   OK"; \
	else \
		echo "   Not installed or not working"; \
		echo "   Run 'make setup' to install dependencies."; \
	fi; \
	echo ""; \
	\
	echo "=== Verification complete ==="; \
	echo ""; \
	if [ $$ERRORS -eq 0 ]; then \
		echo "All critical checks passed!"; \
		echo ""; \
		echo "Ready to build: make build"; \
	else \
		echo "Some checks failed. Please fix the errors above."; \
		exit 1; \
	fi

# =============================================================================
# Build Targets
# =============================================================================

build:
	npx tsc -b claude codex opencode

clean:
	rm -rf slack/dist claude/dist codex/dist opencode/dist

test:
	npm run test -- --maxWorkers=$(JOBS)

sdk-test:
	npm run test:claude -- --maxWorkers=$(JOBS)
	npm run test:codex -- --maxWorkers=$(JOBS)
	npm run test:opencode -- --maxWorkers=$(JOBS)

claude-test:
	npm run test -- --maxWorkers=$(JOBS) tests/unit/claude tests/integration/claude

codex-test:
	npm run test -- --maxWorkers=$(JOBS) tests/unit/codex tests/integration/codex

opencode-test:
	npm run test:opencode:all -- --maxWorkers=$(JOBS)

claude-sdk-test:
	npm run test:claude -- --maxWorkers=$(JOBS)

codex-sdk-test:
	npm run test:codex -- --maxWorkers=$(JOBS)

opencode-sdk-test:
	npm run test:opencode -- --maxWorkers=$(JOBS)

# =============================================================================
# Run Targets
# =============================================================================

claude-dev:
	cd claude && make dev

codex-dev:
	cd codex && make dev

opencode-dev:
	cd opencode && make dev

claude-start:
	cd claude && make build && make start

codex-start:
	cd codex && make build && make start

opencode-start:
	cd opencode && make build && make start
