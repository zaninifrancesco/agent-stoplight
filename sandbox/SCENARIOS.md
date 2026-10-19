# Sandbox scenarios

Everything here runs against a throwaway copy of `sandbox/template`, **outside** this repository
(Claude Code refuses edits inside a directory loaded with `--plugin-dir`).

```bash
bash sandbox/reset.sh            # prints the workspace path, default ~/agent-stoplight-sandbox
```

On Windows PowerShell use `.\sandbox\reset.ps1`. There, `bash` is usually WSL's, which can't read `C:/…` paths.
The reset empties the folder rather than deleting it, so it works even with a terminal still open in it.

## Automated

| Command | What it runs | Cost |
|---|---|---|
| `claude plugin test` | 86 unit and hook tests against a fake file system, clock and session: shell parser, strict mode, Windows/POSIX paths, hold modes, waiting in line, auto-resume and its budget, deadlocks | No model, no network |
| `bash sandbox/e2e.sh` | Real sessions: a peer's file is refused (Edit); a free file is edited and leased; a `sed -i` on a peer's file is **not run** (Bash); strict mode claims through a real atomic `mkdir` | 5 short haiku calls |
| `bash sandbox/e2e-notify.sh` | Two real sessions at once: B is refused, **A is told B is waiting** (and A's Claude never sees the protocol message), A releases on exit | 2 haiku calls, ~2 min |

The e2e scripts use their own workspace (`~/agent-stoplight-sandbox-e2e`, or `E2E_DIR`), never the one you use by hand.
Set `STOPLIGHT_TRACE=1` on any session to get `.claude/stoplight/trace-<label>.log`: every claim, block, message, release and resume.

Auto-resume needs interactive sessions (a `claude -p` run ends with its turn), so it is covered by the hook tests and by the manual hand-off below.

## Manual: see the lights yourself

You need two terminals, both in the workspace:

```bash
cd ~/agent-stoplight-sandbox
claude --plugin-dir /path/to/agent-stoplight
```

The band sits right above the prompt. Lights are coloured pills; at most one alert pill shows at a time.

| Step | What you should see |
|---|---|
| Both sessions start | `🚦 stoplight  🟢 0 yours  🟡 no peers  🔴 0 blocks  /stoplight` (all dim) |
| T1: "Add a `shout` function to `src/api.ts`" | T1: green pill ` 🟢 1 yours `. Within ~5 s T2: yellow pill ` 🟡 1 peer ` and `s-xxxx (1)` |
| T1 finishes its answer | T1's pill counts down: ` 🟢 1 yours · free in 1:59 `. After 2 minutes the file goes back by itself |
| T2: "Add a `byId` helper to `src/db.ts`" | Allowed, but **yellow** alert: ` 🟡 s-xxxx is also editing in src/ (api.ts) ` and a toast |
| T2: "Rename `greet` to `welcome` in `src/api.ts`" (while T1 still holds it) | Refused. T2: **red** alert ` 🔴 BLOCKED src/api.ts · held by s-xxxx `, then a **blue** pill ` ⏳ waiting for src/api.ts (s-xxxx) · resumes automatically `. T2's Claude stops and says it is waiting |
| …at the same moment in T1 | **Yellow** alert ` 🔔 s-yyyy is waiting for src/api.ts `. T1's Claude is not interrupted |
| T1 finishes its answer | Because T2 is waiting, T1 hands the file over **at once** (no countdown): cyan ` ➜ handed src/api.ts to s-yyyy ` |
| …a second later in T2 | **Green** ` ▶ src/api.ts is free: resuming the task `, and **T2 continues by itself**. The prompt from agent-stoplight quotes what T1's Claude said when it finished ("Added shout()…"), so T2 knows what changed. It re-reads the file and finishes the rename |
| (no one waiting) T1 finishes its answer | The countdown ` free in 1:59 ` runs instead, for a quick "continue" |
| T1: `/stoplight` | The board: header pills, `FILES` (with `🔔 s-yyyy waiting`), `WAITING FOR`, `RECENT` events, buttons **Release mine** `r` · **Refresh** `f` · **Pause** `p` |
| Make the terminal narrow | The band shortens (` 🟢 2 `, ` 🔴 api.ts · s-xxxx `) but always keeps the file name |
| T1 holds `src/api.ts`. T2: "run `sed -i 's/hello/hi/' src/api.ts`" | The command is **not run**: red alert, toast `🔴 command not run: src/api.ts locked by s-xxxx`, T2 waits in line and resumes like an edit |
| T1 holds `api.ts` and wants `db.ts`; T2 holds `db.ts` and wants `api.ts` | A **magenta** ` ↔ deadlock with s-xxxx: handed over … ` on exactly one of the two: that session gives its file back and waits, the other finishes, then the first resumes |
| T2: `/stoplight strict on` | A cyan `🔒 strict` tag on the band. The first edit of each file is ~200 ms slower on Windows, and two sessions can never both win a file |

Commands:

```bash
node sandbox/tools/peer.mjs <repoRoot> hold src/db.ts     # a fake peer, no second terminal needed (Ctrl+C releases)
/stoplight status                                          # text summary, also works in claude -p
/stoplight hold turn | idle | session                      # how long files are held (default turn); STOPLIGHT_HOLD, /plugin configure
/stoplight auto on | off                                   # resume a waiting session by itself (default on)
/stoplight pause | resume                                  # turn the guard off and on for this session
/stoplight strict on | off                                 # atomic claims (or STOPLIGHT_STRICT=1, or /plugin configure)
/stoplight shell on | off                                  # guard Bash/PowerShell writes (default on)
```

## Known limits (measured, not guessed)

- **The hand-off summary is the other session's closing words, not a diff.** It is clipped to 600 characters and quoted to the receiving Claude as context, never as instructions. Claude still re-reads the file itself.
- **Each auto-resume is a Claude turn**, so it uses tokens. At most 3 resumes per file in 30 minutes; after that the band says so and you retry by hand.
- **Deadlocks are untangled between two sessions.** Longer cycles (A→B→C→A) are not detected; the 2-minute hand-back after each task breaks them in practice.
- **Messages between sessions are an accelerator, not a requirement.** In auto mode (the Desktop app's default) Claude Code may refuse `$.session.send`, and it is never available during `session.end`. The protocol therefore also runs through files next to the leases: a waiting session writes `<id>.<sid>.wait`, the owner finds it on its 5-second scan, and a release leaves `<id>.handoff` with the closing summary. Worst case, a hand-off takes one scan (≤5 s) instead of an instant.
- **Delivered messages are wrapped.** Claude Code wraps them in a `<cross-session-message …>` envelope, so the protocol marker is searched anywhere in the text.
- **Shell guarding is best effort.** It covers redirects, `tee`, `sed -i`, `perl -i`, `mv`, `cp`, `rm`, `touch`, `truncate`, `ln`, `dd of=`, `git checkout --`/`restore`/`rm`/`mv`, `prettier --write`, and PowerShell `Set-Content`, `Add-Content`, `Out-File`, `*-Item`. It deliberately skips globs, `$VARS`, `~` and writes made from inside other programs (`python -c`, `node -e`, build tools).
- **Strict mode needs every session to opt in.** A session without it doesn't take the mkdir lock. Lock directories (`<id>@<state>.lock`) pile up in `.claude/stoplight/leases/`; they are empty and safe to delete when no session is running.
- **macOS and Linux are covered by the unit tests and the CI matrix, but not yet run for real.** `.github/workflows/ci.yml` runs validate and tests on all three platforms, plus an optional benchmark (`spike/tools/race.sh`).
- **Painting is unverified.** Colours and layout are checked as an element tree, not as pixels. Look once per terminal you care about: Windows Terminal, iTerm2, VS Code, Desktop app.
