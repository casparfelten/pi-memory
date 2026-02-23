# Live Drive Report — 2026-02-22

> **Scripted (no LLM).** Extension API exercised programmatically via `scripts/live-drive-actual-use.mjs`. Validates end-to-end API behaviour and XTDB persistence, not model decision-making.

## Summary verdict

**PASS** for "live actual use".

I ran the Phase3 extension against **real XTDB** (`http://172.17.0.1:3000`) in a real workspace, drove the tool-wrapped APIs end-to-end, executed a ~72s long-running update loop with watcher capture, and verified continuity across close/reload with reconciliation of while-down edits.

## What was actually driven live

### Environment
- Repo: `~/self-context-manager`
- Branch: `live-drive/actual-use-2026-02-22`
- XTDB: `http://172.17.0.1:3000` (no mocks)
- Workspace used by runner: `/workspace/self-context-manager/tmp/live-drive-workspace`
- Session id: `live-drive-1771736349639`

### Runner script added
- `scripts/live-drive-actual-use.mjs`

### Exact command(s) used
```bash
cd ~/self-context-manager
node scripts/live-drive-actual-use.mjs
```

### APIs exercised end-to-end
1. `load()` + session init/persist
2. `wrappedWrite(path, content)`
3. `wrappedEdit(path)`
4. `wrappedLs(output)`
5. `wrappedFind(output)`
6. `wrappedGrep(output)`
7. `read(path)` activation flow (index + activate)
8. `deactivate(id)` then `activate(id)`
9. `transformContext(messages)` with realistic `user` + `assistant` + `toolResult`
10. `observeToolExecutionEnd('bash', command)` path-hint ingestion
11. `close()` and reload same session id via fresh extension instance

## Evidence highlights

Primary evidence artifact:
- `docs/rebuild/2026-02-22-live-drive-evidence.json`

### Timeline (UTC)
- `04:59:09` load start
- `04:59:10` load done (`session:live-drive-1771736349639`)
- `04:59:11` wrappedWrite + wrappedEdit on `notes/live.txt`
- `04:59:12` discovery wrappers (ls/find/grep), read(), deactivate/activate, transformContext, observeToolExecutionEnd
- `04:59:12` long-run start on `notes/longrun.log`
- `04:59:25` history length 5 (sample i=4)
- `04:59:42` history length 9 (sample i=8)
- `04:59:59` history length 13 (sample i=12)
- `05:00:16` history length 17 (sample i=16)
- `05:00:21` run done, extension closed
- `05:00:21` file mutated while extension down
- `05:00:23` reload complete and reconciliation observed

### Tool API behavior observed
- `wrappedWrite`/`wrappedEdit`: persisted file body + metadata; updates reflected in XTDB entity char counts.
- `wrappedLs`/`wrappedFind`/`wrappedGrep`: discovered files inserted as metadata/file objects; grep parsing by `path:` prefix worked.
- `read(path)`: returned `ok` and concrete id:  
  `file:/workspace/self-context-manager/tmp/live-drive-workspace/notes/live.txt`
- `activate`/`deactivate`: both succeeded on readable file id.
- `transformContext`: output included:
  - `METADATA_POOL` user block,
  - mapped `toolResult` as `toolcall_ref id=tc-live-1 tool=bash status=ok`,
  - `ACTIVE_CONTENT` injection for active file content.
- `observeToolExecutionEnd('bash', ...)`: accepted bash command string with path-like tokens; no errors and path discovery flow remained consistent.

### Long-running task outcomes (~72s)
- File: `file:/workspace/self-context-manager/tmp/live-drive-workspace/notes/longrun.log`
- Loop: 16 appends every ~4s (+ initial write), watcher active during run.
- XTDB history growth during run:
  - i=4: len 5
  - i=8: len 9
  - i=12: len 13
  - i=16: len 17
- Post-reload (after while-down append + reconcile): history len **18**.
- Reloaded entity `char_count`: **602** and content includes `tick-after-close ...` line.

### Continuity check results
- Active set continuity preserved across restart:
  - before close: `chat`, `notes/live.txt`, `tc-live-1`
  - after reload: same active set
- While-down reconciliation succeeded:
  - appended while extension closed
  - reload indexed the delta and XTDB history advanced from 17 → 18

### XTDB evidence snippets
- Session id: `session:live-drive-1771736349639`
- Long-run file id: `file:/workspace/self-context-manager/tmp/live-drive-workspace/notes/longrun.log`
- History first/last sample (queried live):
  - first: `{"txTime":"2026-02-22T04:59:12Z","txId":1373,"validTime":"2026-02-22T04:59:12Z",...}`
  - last: `{"txTime":"2026-02-22T05:00:22Z","txId":1565,"validTime":"2026-02-22T05:00:22Z",...}`

## Blockers / fixes / workarounds

- `getAsOf` check against the first `txTime` returned `XTDB HTTP 404 Not Found` in this environment.
  - Workaround used: rely on `history()` progression + current entity validation for continuity proof.
  - No code fallback/mock introduced.

## Pass/fail conclusion for "live actual use"

**PASS**.

The extension was exercised in real operation mode against live XTDB with concrete file IO, discovery wrappers, context transformation, long-running watcher-driven versioning, and session continuity/reconciliation across restart.
