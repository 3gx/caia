# CAIA Shared Session Architecture

## Overview

Three independent bots (Claude, Codex, OpenCode) share common infrastructure from `slack/` while maintaining complete isolation. Each bot has its own session file, conversation tracker, and can operate in parallel with other bots. Within a single bot, concurrent queries to the same session are blocked.

---

## Key Architectural Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Conversation key separator | `_` | URL-safe, no encoding needed |
| Session file location | `~/.config/caia/` or `CAIA_SESSIONS_PATH` (directory) | Stable across cwd changes |
| Session file per agent | Yes | Complete isolation, independent lifecycles |
| ConversationTracker | Per-agent instance | No shared state between bots |
| Busy lock scope | **Per-sessionId** | Same session can be active in multiple channels via /resume |
| Fork point tracking | Shared interface, agent-specific implementation | Consistent behavior, flexible internals |
| Fork point | Assistant message clicked | [Fork Here] only on assistant messages |
| Fork fallback | None | Error shown if channel creation fails |
| Busy state | In-memory only | Safe to lose on crash, no stale locks |
| Session data | Persisted to JSON | Must survive restart for continuity |
| Unified mode interface | plan / ask / bypass | Agent implements backend mapping |
| Backward compatibility | None | Nuke old data, fresh start |

---

## 1. Directory Structure

```
slack/src/
├── index.ts                      # Barrel export
├── types.ts                      # Existing: IAgent, AgentCapabilities, IModelProvider
├── errors.ts                     # Existing: SlackBotError, toUserMessage
├── retry.ts                      # Existing: withSlackRetry, withRetry
├── file-handler.ts               # Existing: processSlackFiles
├── markdown-png.ts               # Existing: markdownToPng
│
├── session/
│   ├── index.ts                  # Barrel export for session module
│   ├── types.ts                  # Base session interfaces
│   ├── conversation-key.ts       # makeConversationKey, parseConversationKey
│   ├── conversation-tracker.ts   # In-memory busy state + active contexts
│   └── base-session-manager.ts   # Abstract base with mutex + persistence
│
├── activity/
│   ├── index.ts                  # Barrel export
│   ├── types.ts                  # ActivityEntry, ActivityType
│   ├── activity-manager.ts       # Rolling window logic, entry formatting
│   ├── activity-blocks.ts        # Shared Block Kit builders for activity
│   └── activity-thread.ts        # Thread posting, batch updates
│
├── ui/
│   ├── index.ts                  # Barrel export
│   ├── status-blocks.ts          # Status panel blocks (model, tokens, session)
│   ├── fork-blocks.ts            # Fork Here button, fork modal
│   ├── abort-blocks.ts           # Abort button, confirmation modal
│   └── emoji-reactions.ts        # Processing emoji helpers
│
└── notifications/
    ├── index.ts                  # Barrel export
    └── dm-notifications.ts       # DM notification on completion
```

---

## 2. Session Management

### 2.1 Session File Location

**Default:** `~/.config/caia/` (directory)
**Override:** `CAIA_SESSIONS_PATH` environment variable (must be a directory path)

```
~/.config/caia/
├── claude-sessions.json
├── codex-sessions.json
└── opencode-sessions.json
```

On startup:
- If `CAIA_SESSIONS_PATH` is set, use that directory
- Otherwise use `~/.config/caia/`
- Create directory if it doesn't exist
- Ignore/delete any old `./sessions.json` in cwd (no backward compatibility)

### 2.2 Session File Structure

Each agent has its own file with identical structure:

```typescript
{
  "channels": {
    "C_PROJECT_ALPHA": {
      // Base session fields (shared interface)
      "workingDir": "/projects/alpha",
      "createdAt": 1706000000000,
      "lastActiveAt": 1706001000000,
      "pathConfigured": true,
      "configuredPath": "/projects/alpha",
      "configuredBy": "U_USER1",
      "configuredAt": 1706000000000,
      "updateRateSeconds": 3,
      "threadCharLimit": 500,
      
      // Agent-specific session ID (naming varies, interface same)
      "sessionId": "ses_abc123",        // Claude: SDK session ID
      // OR "threadId": "thread_xyz",   // Codex: Codex thread ID
      
      // Unified mode (all agents)
      "mode": "ask",                    // "plan" | "ask" | "bypass"
      
      "model": "claude-sonnet-4-20250514",
      "lastUsage": { ... },
      
      // Fork point tracking (REQUIRED - shared interface)
      "messageMap": {
        "111.222": {
          "pointId": "msg_def",         // Agent-specific identifier
          "sessionId": "ses_abc123",
          "type": "assistant",
          "parentSlackTs": "111.111"
        }
      },
      
      // Thread sessions
      "threads": {
        "123.456": {
          "sessionId": "ses_forked_789",
          "forkedFrom": "ses_abc123",
          "forkPointId": "msg_def",
          "workingDir": "/projects/alpha",
          "mode": "ask",
          // ... inherits other fields
        }
      }
    }
  }
}
```

### 2.3 Base Session Interface

```typescript
// slack/src/session/types.ts

/**
 * Unified mode interface for all agents.
 * Agents map this to their backend-specific settings.
 */
type UnifiedMode = 'plan' | 'ask' | 'bypass';

interface BaseSession {
  // Working directory
  workingDir: string;
  
  // Timestamps
  createdAt: number;
  lastActiveAt: number;
  
  // Path configuration (immutable once set)
  pathConfigured: boolean;
  configuredPath: string | null;
  configuredBy: string | null;
  configuredAt: number | null;
  
  // Unified mode
  mode: UnifiedMode;
  
  // UI configuration
  updateRateSeconds?: number;   // 1-10, default 3
  threadCharLimit?: number;     // 100-36000, default 500
}

interface BaseThreadSession extends BaseSession {
  forkedFrom: string | null;    // Parent session ID
  forkPointId?: string;         // Point-in-time fork reference
}

// Fork point tracking (REQUIRED for all agents)
interface MessageMapping {
  pointId: string;              // Agent-specific: SDK msg ID, turn ID, etc.
  sessionId: string;            // Session this message belongs to
  type: 'user' | 'assistant';
  parentSlackTs?: string;       // Links response to triggering message
}

interface ForkPoint {
  pointId: string;
  sessionId: string;
}
```

### 2.4 Unified Mode Interface

**Three modes only:** `plan` | `ask` | `bypass`

| Unified Mode | Description |
|--------------|-------------|
| `plan` | Read-only, writes to plan file |
| `ask` | Ask before tool execution |
| `bypass` | Auto-approve everything |

**Agent Backend Mappings:**

| Unified | Claude Backend | Codex Backend |
|---------|----------------|---------------|
| `plan` | `permissionMode: 'plan'` | N/A (declares `supportsPlan: false`) |
| `ask` | `permissionMode: 'default'` | `approvalPolicy: 'on-request'` + `sandbox: 'danger-full-access'` |
| `bypass` | `permissionMode: 'bypassPermissions'` | `approvalPolicy: 'never'` + `sandbox: 'danger-full-access'` |

**Removed/Changed:**
- Claude's `acceptEdits` mode: **DROPPED** from unified interface
- Codex `/policy` command: **REMOVED** - use `/mode` instead
- Codex `/sandbox` command: **REMOVED** - always `danger-full-access` internally
- OpenCode: TBD, has plan/build modes to map later

### 2.5 Conversation Tracker (In-Memory)

```typescript
// slack/src/session/conversation-tracker.ts

interface ActiveContext {
  conversationKey: string;      // channelId_threadTs for context lookup
  sessionId: string;            // For busy lock
  statusMsgTs: string;          // Activity message being updated
  originalTs: string;           // User's message (for emoji reactions)
  startTime: number;
  userId?: string;
  query?: string;               // For DM preview
}

class ConversationTracker<T extends ActiveContext> {
  private busySessions: Set<string>;    // Keyed by sessionId
  private contexts: Map<string, T>;     // Keyed by conversationKey
  
  isBusy(sessionId: string): boolean;
  startProcessing(sessionId: string, ctx: T): boolean;  // Returns false if session busy
  stopProcessing(sessionId: string): void;
  getContext(conversationKey: string): T | undefined;
  getContextBySessionId(sessionId: string): T | undefined;
  updateContext(conversationKey: string, updates: Partial<T>): void;
}
```

### 2.6 Busy Lock Scope

**Rule:** Per-sessionId (NOT per-channel).

Why: The same session can be used in multiple channels via `/resume`. If a session is processing, ALL channels using that session must be blocked.

**Scenario:**
1. Claude has `ses_abc` in `#alpha`, processing a query
2. User runs `/resume ses_abc` in `#beta` (now #beta also uses `ses_abc`)
3. User sends query to Claude in `#beta` → **BLOCKED** because `ses_abc` is busy
4. User sends query to Claude in `#gamma` (different session `ses_def`) → **ALLOWED**

```typescript
// Busy check uses sessionId
function canProcess(sessionId: string): boolean {
  return !tracker.isBusy(sessionId);
}

// Context lookup uses conversationKey (for abort, status updates)
function getConversationKey(channelId: string, threadTs?: string): string {
  return threadTs ? `${channelId}_${threadTs}` : channelId;
}
```

### 2.7 What Gets Persisted vs In-Memory

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         AGENT INSTANCE (e.g., Claude)                        │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ IN-MEMORY (ConversationTracker)                                      │    │
│  │                                                                       │    │
│  │ busySessions: Set {                                                  │    │
│  │   "ses_abc123",        ← This session is processing                  │    │
│  │   "ses_def456"         ← This session is also processing             │    │
│  │ }                                                                     │    │
│  │                                                                       │    │
│  │ activeContexts: Map {                                                │    │
│  │   "C_ALPHA" → { sessionId: "ses_abc123", statusMsgTs: "...", ... }   │    │
│  │   "C_BETA_123.456" → { sessionId: "ses_def456", ... }                │    │
│  │ }                                                                     │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ PERSISTED (~/.config/caia/claude-sessions.json)                      │    │
│  │                                                                       │    │
│  │ - sessionId, workingDir, mode, model                                 │    │
│  │ - messageMap (for fork point lookup) - IMMUTABLE                     │    │
│  │ - lastUsage, pathConfigured, etc.                                    │    │
│  │ - Thread sessions                                                     │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
```

| Data | Storage | Why |
|------|---------|-----|
| `busySessions` | In-memory | Transient state, cleared on restart is OK |
| `activeContexts` | In-memory | Status message refs, cleared on restart is OK |
| `sessionId` | Persisted | Must survive restart to continue conversations |
| `messageMap` | Persisted | Must survive restart for fork-point lookup, immutable |
| `workingDir`, `mode`, etc. | Persisted | Configuration must survive |

---

## 3. Fork System

### 3.1 Fork Point Definition

**Rule:** Fork point = the assistant message where [Fork Here] was clicked.

- [Fork Here] button only appears on assistant messages
- Fork point is always the clicked message itself
- No "last assistant before ts" logic needed

### 3.2 Fork Here Button

Appears on every assistant response message:

```
┌─────────────────────────────────────────────────────────────┐
│ [response content...]                                        │
│                                                              │
│ Tokens: 1,234 in / 567 out | Cost: $0.02                    │
│                                                              │
│ [Fork Here]                                                  │
└─────────────────────────────────────────────────────────────┘
```

### 3.3 Fork Flow

1. User clicks `[Fork Here]` on assistant message
2. Modal opens: "Fork to New Channel"
   - Channel name input (default: `fork-<original>-<timestamp>`)
   - Shows fork point info
3. User confirms
4. System:
   - Creates new Slack channel via `conversations.create`
   - If creation fails → show error via `chat.postMessage` (NO FALLBACK)
   - Looks up `messageMap[slackTs]` → gets `ForkPoint`
   - Agent creates forked backend session (implementation-specific)
   - Posts welcome message in new channel
5. Source channel unchanged - all messages remain forkable

### 3.4 Fork Channel Creation - No Fallback

If channel creation fails:
- Show error message in source channel thread
- Detailed error for: `name_taken`, `invalid_name`, `no_permission`, etc.
- User must fix the issue and retry
- NO automatic fallback to thread or DM

### 3.5 messageMap Behavior

**Rule:** messageMap is per-channel and immutable.

On fork:
- Source channel keeps its messageMap intact
- All messages (before AND after fork point) remain forkable
- New forked channel starts with empty messageMap
- New channel builds its own messageMap as conversation progresses

On `/resume`:
- messageMap is NOT cleared
- lastUsage is NOT cleared
- Path is set from resumed session and locked

### 3.6 Fork Interface (Shared)

```typescript
// Shared interface - all agents implement
interface IForkable {
  /**
   * Find fork point for a Slack message timestamp.
   * Returns the clicked assistant message's mapping.
   */
  findForkPoint(channelId: string, slackTs: string): ForkPoint | null;
  
  /**
   * Create a forked backend session at the given point.
   * Returns new session ID.
   * 
   * Implementation is agent-specific:
   * - Claude: Uses SDK resumeSessionAt with message ID
   * - Codex: Uses forkThreadAtTurn with turn index (converts internally)
   * - OpenCode: TBD
   */
  createForkedSession(forkPoint: ForkPoint, workingDir: string): Promise<string>;
}
```

**Note:** Internal storage format (what goes in `pointId`, how turn indices are stored/computed) is agent-specific implementation detail. The shared interface only defines the contract.

---

## 4. Commands

### 4.1 /status (Unified)

Combines session info + context usage:

```
┌─────────────────────────────────────────────────────────────┐
│ :information_source: Session Status                          │
├─────────────────────────────────────────────────────────────┤
│ Session ID: ses_abc123def456                                 │
│ Working Dir: /projects/alpha                                 │
│ Path Locked: Yes (by @user1 on Jan 15)                      │
│                                                              │
│ Model: claude-sonnet-4-20250514                             │
│ Mode: ask                                                    │
│                                                              │
│ Context Usage:                                               │
│ ████████████░░░░░░░░ 45% (89,234 / 200,000 tokens)          │
│                                                              │
│ Last Query:                                                  │
│   Input: 12,345 tokens (8,234 cached)                       │
│   Output: 2,456 tokens                                       │
│   Cost: $0.12                                                │
│                                                              │
│ Auto-compact at: 85% (~170K tokens)                         │
│ Tokens until compact: ~81K                                   │
├─────────────────────────────────────────────────────────────┤
│ [Clear Context] [Change Model] [Change Mode]                 │
└─────────────────────────────────────────────────────────────┘
```

### 4.2 /resume <session-id>

Resume any valid session in current channel:

```
@bot /resume ses_xyz789
```

**Behavior:**
1. User provides session-id
2. Session can be from:
   - Another Slack channel (same bot)
   - CLI (claude code, codex, opencode started from terminal)
   - Any valid session for that agent's backend
3. Bot resumes the session (implementation details handled internally)
4. Sets `workingDir` from the resumed session
5. Locks path (`pathConfigured = true`)
6. Updates channel's active sessionId
7. Post confirmation with session info

**Note:** The session may not exist in our session file (if started from CLI). The agent backend knows about it - we just need to track it going forward.

### 4.3 /mode

Opens mode picker with 3 options:

```
┌─────────────────────────────────────────────────────────────┐
│ Select Mode                                                  │
├─────────────────────────────────────────────────────────────┤
│ [Plan]   Read-only, writes to plan file                     │
│ [Ask]    Ask before tool execution (default)                │
│ [Bypass] Auto-approve everything                            │
└─────────────────────────────────────────────────────────────┘
```

- If agent doesn't support `plan` (e.g., Codex), that option is hidden/disabled
- Agent maps selection to backend-specific settings
- **Removed:** `/policy` and `/sandbox` commands (Codex-specific, replaced by unified `/mode`)

### 4.4 Other Commands

| Command | Description | Shared Interface |
|---------|-------------|------------------|
| `/clear` | Clear context, start fresh session | Yes |
| `/path <dir>` | Set working directory (first time only) | Yes |
| `/model` | Open model picker (agent provides model list) | Yes |
| `/mode` | Open mode picker (plan/ask/bypass) | Yes |
| `/update-rate <1-10>` | Set status update frequency | Yes |
| `/limit <100-36000>` | Set thread message char limit | Yes |
| `/help` | Show available commands | Yes |

### 4.5 Deferred Commands

The following commands are **DEFERRED** and may be removed:
- `/watch` - Terminal session watching (Claude-specific)
- `/stop-watching` - Stop terminal watching
- `/ff` - Fast-forward sync from terminal

These features and their associated buttons (`[Stop Watching]`) are out of scope for MVP.

---

## 5. Activity System

### 5.1 Activity Entry Types

```typescript
type ActivityType = 
  | 'starting'      // "Analyzing request..."
  | 'thinking'      // Extended thinking block
  | 'tool_start'    // Tool execution started
  | 'tool_complete' // Tool execution finished
  | 'generating'    // Text generation in progress
  | 'error'         // Error occurred
  | 'aborted'       // User aborted
  | 'complete';     // Turn finished

interface ActivityEntry {
  timestamp: number;
  type: ActivityType;
  
  // Tool info
  tool?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: string;
  toolIsError?: boolean;
  durationMs?: number;
  
  // Thinking info
  thinkingContent?: string;
  thinkingTruncated?: string;
  
  // Thread message linking
  threadMessageTs?: string;
  threadMessageLink?: string;
  
  // Result metrics
  lineCount?: number;
  matchCount?: number;
}
```

### 5.2 Rolling Activity Window

```
┌─────────────────────────────────────────────────────────────┐
│ ◐ Processing...                                              │
│                                                              │
│ :gear: Starting...                                           │
│ :thought_balloon: *Thinking* (2.3s)                    [view]│
│ :mag: Grep "session" in *.ts → 47 matches              [view]│
│ :page_facing_up: Read slack/src/types.ts (42 lines)    [view]│
│ :pencil2: Edit codex/src/streaming.ts [in progress]          │
├──────────────────────────────────────────────────────────────┤
│ Session: ses_abc123 | Model: claude-sonnet-4                 │
│ Mode: ask | Context: 45% (89K/200K) | Cost: $0.12           │
│                                                              │
│ [Abort]  [View Log]                                          │
└─────────────────────────────────────────────────────────────┘
```

**Behavior:**
- Max 20 entries shown (rolling window)
- `[in progress]` while tool running, updates to `→ result` when complete
- Each entry has `[view]` link to thread message
- Spinner cycles: ◐ ◓ ◑ ◒

### 5.3 Activity Thread

Detailed entries posted as thread replies:

```
User's message (@bot do something)
  └── :gear: Starting analysis...
  └── :thought_balloon: **Thinking** (2.3s)
      > First 500 chars of thinking content...
  └── :mag: **Grep** "session" in *.ts
      > Found 47 matches across 12 files
  └── :white_check_mark: **Complete** (12.4s, 89K tokens, $0.12)
```

### 5.4 Response Attachments

**Button:** `[Attach Response]` (renamed from `[Attach Thinking]`)

**Behavior:**
- Response always attempts to attach both `.md` and `.png` files
- `.md` file: ALWAYS attached for truncated responses (same limits as ccslack)
- `.png` file: Attached if Puppeteer rendering succeeds
- `[Attach Response]` button: Shows if EITHER `.md` or `.png` failed to attach
- Clicking button retries attachment of whichever failed

**Flow:**
1. Response is truncated (exceeds char limit)
2. Attempt to attach `response.md` → success/fail
3. Attempt to render and attach `response.png` via Puppeteer → success/fail
4. If both succeed: no button shown
5. If either fails: show `[Attach Response]` button

---

## 6. DM Notifications

### 6.1 Format

When query completes, send DM to user:

```
:white_check_mark: `Implement the session interface...` #project-alpha [View]
```

**Components:**
- Status icon: `:white_check_mark:` (success), `:x:` (error), `:stop_sign:` (aborted)
- Query preview: First ~50 chars in backticks
- Channel link
- View button: permalink to response

---

## 7. Emoji Reactions

| State | Emoji | When |
|-------|-------|------|
| Processing started | :eyes: | Query received |
| Waiting for approval | :raised_hand: | Tool needs approval |
| Complete (success) | :white_check_mark: | Response posted |
| Complete (error) | :x: | Error occurred |
| Aborted | :stop_sign: | User clicked Abort |

---

## 8. Bot Isolation Model

### 8.1 Three Bots, One Workspace

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         SLACK WORKSPACE                                      │
│                                                                              │
│  ┌─────────────────────┐ ┌─────────────────────┐ ┌─────────────────────┐    │
│  │ Claude Bot          │ │ Codex Bot           │ │ OpenCode Bot        │    │
│  │ @claude             │ │ @codex              │ │ @opencode           │    │
│  │                     │ │                     │ │                     │    │
│  │ ConversationTracker │ │ ConversationTracker │ │ ConversationTracker │    │
│  │ claude-sessions.json│ │ codex-sessions.json │ │ opencode-sessions   │    │
│  └─────────────────────┘ └─────────────────────┘ └─────────────────────┘    │
│                                                                              │
│  #project-alpha:                                                            │
│    Claude: ses_c1 (processing) ─┐                                           │
│    Codex:  thread_x1 (idle)     ├─ All three can have sessions here        │
│    OpenCode: oc_a1 (processing) ─┘                                          │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 8.2 Isolation Rules

1. **Bot Isolation**: Each bot is completely independent
   - Own session file in `~/.config/caia/`
   - Own ConversationTracker instance
   - Can all process in same channel simultaneously

2. **Session Isolation**: Within a bot, each session is independent
   - Different sessions can process in parallel
   - Same session blocks concurrent queries (even across channels via /resume)

3. **Concurrent Query Blocking**: Same bot + same session = blocked
   - Query to @claude with `ses_abc` while `ses_abc` is processing → **blocked**
   - Query to @codex in same channel → **allowed** (different bot)
   - Query to @claude with `ses_def` → **allowed** (different session)

### 8.3 Crash Recovery

**On crash:**
- In-memory `ConversationTracker` is lost
- Persisted sessions in `~/.config/caia/` remain intact

**On restart:**
- busySessions is empty (all sessions appear idle)
- Old "Processing..." messages in Slack are orphaned (cosmetic)
- User can immediately send new query
- Session context (history, fork points) is preserved

---

## 9. Implementation Phases

### Phase 1: Core Session Infrastructure (slack/)

1. Create `slack/src/session/` module:
   - `types.ts` - Base interfaces, UnifiedMode
   - `conversation-key.ts` - Key utilities with `_` separator
   - `conversation-tracker.ts` - Per-sessionId busy tracking
   - `base-session-manager.ts` - Abstract base with `~/.config/caia/` location

2. Create `slack/src/activity/` module:
   - `types.ts` - ActivityEntry interface
   - `activity-manager.ts` - Rolling window logic

3. Create `slack/src/ui/` module:
   - `emoji-reactions.ts` - Shared emoji helpers

4. Create `slack/src/notifications/` module:
   - `dm-notifications.ts` - Completion DMs

### Phase 2: Migrate Codex to Shared Infrastructure

1. Update `codex/src/session-manager.ts`:
   - Extend `BaseSessionManager`
   - Change to `~/.config/caia/codex-sessions.json`
   - Add unified mode support (map ask→on-request, bypass→never)
   - Remove `/policy` and `/sandbox` commands

2. Update `codex/src/slack-bot.ts`:
   - Replace `streamingManager.isAnyStreaming()` with `ConversationTracker.isBusy(sessionId)`
   - Use `_` separator for conversation keys

3. Delete old `./sessions.json` handling

### Phase 3: Refactor Claude to Use Shared Infrastructure

1. Update `claude/src/session-manager.ts`:
   - Extend `BaseSessionManager`
   - Change to `~/.config/caia/claude-sessions.json`
   - Map unified mode (drop acceptEdits)

2. Update `claude/src/slack-bot.ts`:
   - Replace local `busyConversations` with `ConversationTracker`
   - Use shared emoji reactions

3. Defer `/watch` related code (mark for potential removal)

4. Delete old `./sessions.json` handling

### Phase 4: Implement OpenCode

1. Create `opencode/src/session-manager.ts`:
   - Extend `BaseSessionManager`
   - Use `~/.config/caia/opencode-sessions.json`
   - Map unified mode to OpenCode backend

2. Implement shared patterns from slack/

---

## 10. Testing Strategy

### Unit Tests

- `slack/src/session/` - Conversation key parsing, tracker operations (per-sessionId)
- `slack/src/activity/` - Rolling window logic, entry formatting
- Mode mapping for each agent

### Integration Tests

- Bot isolation: Three bots in same channel don't interfere
- Session isolation: Same bot different sessions process in parallel
- Busy blocking: Same session blocks concurrent queries (even across channels)
- Fork flow: Creates channel, preserves source messageMap
- Crash recovery: Restart with persisted sessions works
- Mode switching: Unified mode maps to correct backend settings
- /resume: Can resume CLI-started sessions, locks path

---

## 11. No Backward Compatibility

On startup, each agent:
1. Ignores any `./sessions.json` in cwd
2. Uses `~/.config/caia/<agent>-sessions.json`
3. Old Slack interactive payloads with `:` separator will fail gracefully
4. All new conversation keys use `_` separator

---

## 12. Open Questions (Deferred)

1. **OpenCode mode mapping**: Has plan/build modes - map to unified interface later
2. **Session cleanup/GC**: When to garbage collect old sessions? TTL? Manual command?
3. **Multi-workspace**: If needed later, add workspace prefix to session files
4. **Terminal watch feature**: `/watch`, `/ff`, `/stop-watching` - keep or remove?
