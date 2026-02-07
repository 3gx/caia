# C.A.I.A. - Central Artificial Intelligence Agency

<p align="center">
  <img src="caia.jpg" alt="C.A.I.A. Logo" width="280">
</p>

A multi-provider Slack bot framework that integrates AI coding assistants into your workspace. Run Claude Code, Codex, or OpenCode through a unified Slack interface.

## Supported Providers

| Provider | SDK | Description |
|----------|-----|-------------|
| **Claude** | @anthropic-ai/claude-agent-sdk | Anthropic's Claude Code with extended thinking |
| **Codex** | OpenAI Codex App-Server | Codex with reasoning levels |
| **OpenCode** | @opencode-ai/sdk | OpenCode AI with agent modes |

## Features

### Core Capabilities
- **Multi-provider Support** - Choose between Claude, Codex, or OpenCode
- **Session Management** - Persistent conversations per channel and thread
- **Real-time Streaming** - Live updates as the AI processes requests
- **File Processing** - Upload images and code files for analysis

### Permission Modes
| Mode | Description |
|------|-------------|
| **Plan** | AI writes plans for approval before execution |
| **Ask** (Default) | Approve each tool use with interactive buttons |
| **Bypass** | Auto-approve all tool usage |

### Interactive Features
- Activity logging with tool execution tracking
- Extended thinking visualization (Claude, OpenCode)
- Markdown to PNG rendering for rich responses
- Terminal session watching and sync
- Fork conversations to new channels

## Quick Start

### Prerequisites
- Node.js 18+
- A Slack workspace with admin permissions
- Provider SDK access (Claude API key, Codex CLI, or OpenCode SDK)

### Installation

```bash
# Clone the repository
git clone <repository-url>
cd caia

# Install dependencies
make setup

# Install native dependencies (for image processing)
make setup-tools

# Verify installation
make verify-tools
```

### Configuration

1. Create a Slack app following the [Setup Guide](./SETUP.md)
2. Configure environment for your chosen provider:

```bash
# For Claude
cp claude/.env.example claude/.env

# For Codex
cp codex/.env.example codex/.env

# For OpenCode
cp opencode/.env.example opencode/.env
```

Edit the `.env` file for your provider:
```bash
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token
```

### Running a Provider

```bash
# Development (with auto-reload)
make claude-dev      # or codex-dev, opencode-dev

# Production (build + run)
make claude-start    # or codex-start, opencode-start
```

See [SETUP.md](./SETUP.md) for complete setup instructions.

## Usage

### Basic Interaction

Mention the bot in any channel where it's present:

```
@BotName /help                    # Show all commands
@BotName /status                  # Show session info
@BotName explain this function    # Ask the AI anything
```

### Commands

#### Session & Configuration
| Command | Description |
|---------|-------------|
| `/help` | Show all available commands |
| `/status` | Show session info (ID, mode, directory) |
| `/context` | Show token usage and context window |
| `/mode [plan\|ask\|bypass]` | View/set permission mode |
| `/model` | Show model picker |
| `/clear` | Clear session history |
| `/compact` | Compress session to reduce context |

#### Directory Navigation
| Command | Description |
|---------|-------------|
| `/ls [path]` | List files in directory |
| `/cd [path]` | Change directory (before path lock) |
| `/cwd` | Show current working directory |
| `/set-current-path` | Lock current directory permanently |

#### Terminal Session
| Command | Description |
|---------|-------------|
| `/watch` | Start watching terminal session |
| `/stop-watching` | Stop watching terminal session |
| `/ff` | Fast-forward sync missed terminal messages |
| `/resume <session-id>` | Resume an existing session |

#### Message Settings
| Command | Description |
|---------|-------------|
| `/update-rate [1-10]` | Set status update interval (seconds) |
| `/message-size [100-36000]` | Set message size limit (chars) |

### Provider-Specific Commands

#### Claude
| Command | Description |
|---------|-------------|
| `/max-thinking-tokens [n]` | Set thinking budget (0-128000) |
| `/show-plan` | Display current plan file |

#### Codex
| Command | Description |
|---------|-------------|
| `/reasoning [level]` | Set reasoning effort (minimal/low/medium/high/xhigh) |
| `/policy [policy]` | Set approval policy |
| `/sandbox [mode]` | Set sandbox mode |

#### OpenCode
| Command | Description |
|---------|-------------|
| `/max-thinking-tokens [n]` | Set thinking budget |
| `/show-plan` | Display current plan file |
| `/continue` | Show terminal continuation command |

## Project Structure

```
caia/
├── slack/                # Shared Slack library
│   └── src/
│       ├── blocks.ts           # Block Kit UI builders
│       ├── commands.ts         # Command parsing
│       ├── streaming.ts        # Real-time streaming
│       ├── session-manager.ts  # Session persistence
│       ├── file-handler.ts     # File processing
│       ├── markdown-png.ts     # Markdown to PNG
│       └── ...
├── claude/               # Claude provider
├── codex/                # Codex provider
├── opencode/             # OpenCode provider
├── Makefile              # Build and run targets
├── SETUP.md              # Slack app setup guide
└── package.json          # Monorepo configuration
```

## Development

### Build & Run

```bash
make build              # Build all providers
make clean              # Remove build artifacts
make help               # Show all available targets
```

### Testing

```bash
make test               # Run unit + integration tests
make sdk-test           # Run live SDK tests for all providers
make claude-test        # Run Claude-specific tests
make codex-test         # Run Codex-specific tests
make opencode-test      # Run OpenCode-specific tests
```

## Environment Variables

### Required (All Providers)
| Variable | Description |
|----------|-------------|
| `SLACK_BOT_TOKEN` | Bot OAuth Token (xoxb-...) |
| `SLACK_APP_TOKEN` | Socket Mode Token (xapp-...) |

### Provider-Specific
| Variable | Provider | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Claude | API key (optional if configured globally) |
| `DEFAULT_WORKING_DIR` | Codex | Default working directory |
| `OPENCODE_PORT_BASE` | OpenCode | Base port for SDK servers (default: 60000) |

## Dependencies

### Runtime
- `@slack/bolt` - Slack Bolt framework
- `@slack/web-api` - Slack Web API client
- `puppeteer` - Markdown to PNG rendering
- `sharp` - Image processing
- `markdown-it` - Markdown parsing
- `zod` - Schema validation

### Development
- `typescript` - TypeScript compiler
- `tsx` - TypeScript execution
- `vitest` - Test framework

## Documentation

- [SETUP.md](./SETUP.md) - Complete Slack app setup guide
- [ARCHITECTURE.md](./ARCHITECTURE.md) - Technical architecture
- [CLAUDE.md](./CLAUDE.md) - Development guide

## Troubleshooting

### Bot Doesn't Respond
1. Check bot is running (verify terminal output)
2. Ensure bot is invited to the channel (`/invite @BotName`)
3. Verify tokens in `.env` are correct
4. Check all Slack scopes are configured (see [SETUP.md](./SETUP.md))

### Image Processing Errors
Run `make verify-tools` to check native dependencies. On Linux, run `make setup-tools` to install required libraries.

### Session Issues
- Use `/clear` to reset the current session
- Use `/status` to check session state
- Session files are stored per provider SDK

## License

BSD-3-Clause
