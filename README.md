# agent-stoplight 🚦

> Traffic lights for AI coding agents: stop parallel Claude Code sessions from overwriting each other's files.

When running multiple Claude Code sessions against the same repository, agents can easily collide, overwrite each other's changes, or trigger merge conflicts. **agent-stoplight** adds automatic concurrency control using a lightweight, filesystem-based lease protocol and a real-time status band.

---

## 🚦 How it works

Before a session touches a file, it checks and acquires a small lease file under `<repo>/.claude/stoplight/leases/`:

- 🟢 **Green (Free / Yours)**: The file is free or already owned by your session. Edits and writes proceed immediately.
- 🟡 **Yellow (Nearby peers)**: Another session is modifying other files in the same directory. The edit goes through, but with a warning toast and indicator.
- 🔴 **Red (Blocked)**: Another live session holds the file. The edit or shell command is refused with an actionable message for Claude. The file owner is notified that a peer is waiting.

When the file is released, waiting sessions are **resumed automatically** with a context summary of what the previous agent changed. If two sessions wait on each other, deadlocks are automatically untangled.

---

## ✨ Features

- **Zero External Dependencies**: Operates entirely over local filesystem leases—no central server or database required.
- **Tool Guarding**: Intercepts `Edit`, `Write`, `MultiEdit`, and `NotebookEdit` tool calls.
- **Shell Guarding**: Static analysis for `Bash` and `PowerShell` commands, preventing commands like `> file`, `>> file`, `tee`, `sed -i`, `mv`, `cp`, `rm`, `git checkout/restore`, or PowerShell `Set-Content` from altering locked files.
- **Live Status Band**: A real-time, non-intrusive status band rendered directly above the prompt (`AbovePrompt`) displaying held files, peer activity, countdown timers, and alerts.
- **Interactive `/stoplight` Board**: A full TUI pane displaying live leases, waiters, and event logs with keyboard shortcuts (`r` to release, `f` to refresh, `p` to pause).
- **Intelligent Hold Modes**:
  - `turn` *(default)*: Keeps files during Claude's active turn plus a 2-minute grace period for follow-ups (hands over immediately if a peer is waiting).
  - `idle`: Releases files after 10 minutes untouched.
  - `session`: Holds files until the session terminates.
- **Contextual Hand-off & Auto-Resume**: Automatically wakes up blocked sessions when files become free, passing a concise summary of the last agent's changes so Claude knows what changed before re-reading.
- **Cycle / Deadlock Detection**: Detects mutual dependencies between two sessions and breaks cycles deterministically without user intervention.
- **Optional Strict Mode**: Uses atomic `mkdir` claims to eliminate millisecond-level race conditions.

---

## 🚀 Getting Started

### Installation

Clone the repository and launch Claude Code with `--plugin-dir`:

```bash
git clone https://github.com/zaninifrancesco/agent-stoplight.git
cd /path/to/your/project
claude --plugin-dir /path/to/agent-stoplight
```

Or configure it in your Claude Code plugin settings.

---

## 🎮 Commands & Controls

Inside Claude Code, use the `/stoplight` slash command:

| Command | Description |
|---|---|
| `/stoplight` | Opens the interactive visual dashboard pane |
| `/stoplight status` | Prints a text summary of active leases and waiters |
| `/stoplight release` | Releases all files currently held by this session |
| `/stoplight hold turn \| idle \| session` | Configures how long files are retained |
| `/stoplight auto on \| off` | Toggles automatic task resumption when files are freed |
| `/stoplight strict on \| off` | Enables atomic `mkdir` claiming for strict race protection |
| `/stoplight shell on \| off` | Toggles Bash & PowerShell command inspection |
| `/stoplight pause \| resume` | Temporarily suspends or re-enables the guard |

---

## 🧪 Testing & Sandbox

### Automated Tests

agent-stoplight comes with 86 unit and hook tests covering the lease protocol, shell tokenizer, deadlock resolution, and edge cases:

```bash
claude plugin test
```

### Sandbox & E2E Validation

A complete sandbox environment is included under `sandbox/`:

```bash
# Reset sandbox workspace
bash sandbox/reset.sh            # On Linux/macOS
.\sandbox\reset.ps1              # On Windows PowerShell

# Run end-to-end tests with real sessions
bash sandbox/e2e.sh
bash sandbox/e2e-notify.sh
```

See [sandbox/SCENARIOS.md](sandbox/SCENARIOS.md) for detailed manual walkthroughs and test scenarios.

---

## 📊 Research & Architecture

Before implementation, an empirical spike benchmarked various atomic claim primitives (`mkdir`, `$.store`, lease files) under high contention across multiple concurrent sessions.

Read [spike/SPIKE.md](spike/SPIKE.md) for full benchmarks, measurements, and design rationale.

---

## 📄 License

[MIT](LICENSE)
