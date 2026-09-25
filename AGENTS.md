# CLAUDE.md — Project Context & Operating Rules

This file is the entry point for any AI assistant (Claude, Cursor's agent, etc.) working
in this repository. Read it before making changes. It is deliberately strict: this
project models real hardware behavior, and a confident wrong answer is worse than an
honest "I don't know."

## What this repo is
An MCP (Model Context Protocol) server that exposes the Tandy Color Computer 3 (CoCo 3),
running under MAME, as a set of tools/resources an LLM client can call — e.g. launching
MAME, sending input, reading video/memory state, and answering questions about CoCo 3
hardware and BASIC/OS-9 behavior grounded in the official manuals.

**Keep this section current — don't let it drift from the actual code:**
- Language & runtime: TypeScript (`strict` mode), compiled to ES2022/Node16 modules;
  runs on Node.js 18+ (`MCP/package.json` `engines.node`). Tests and dev runs execute
  the `.ts` sources directly via `tsx`, no separate dev-build step needed.
- MCP SDK/framework used: `@modelcontextprotocol/sdk` 1.30.0 — `McpServer` +
  `StdioServerTransport` (`MCP/src/index.ts`). Pinned exactly; see
  `MCP/test/source-rules.test.ts`.
- MAME invocation method: CLI subprocess. `MCP/src/mame-process.ts` spawns the local
  `mame.exe` (`node:child_process.spawn`) with `-autoboot_script
  MCP/scripts/bridge.lua`. That Lua autoboot script is not the MAME debugger/console —
  it opens a TCP client socket back to a Node-hosted `net.Server`
  (`MCP/src/bridge-server.ts`) and exchanges newline-delimited JSON commands
  (`MCP/src/protocol.ts`) to mount disks, post keystrokes, read/write the current 64K
  MMU window, and take snapshots.
- Entry point(s): `MCP/src/index.ts` (builds to `MCP/dist/index.js`; run with
  `npm start` from `MCP/`, or point an MCP client at `MCP/dist/index.js` per the root
  `README.md`).
- Test runner & command: Node's built-in `node:test`, run through `tsx`. From the repo
  root: `npm test` (delegates to `npm test --prefix MCP`). From `MCP/`: `npm test`,
  which runs the fixed file list declared in `MCP/package.json`'s `test` script.
- Build/lint commands: `npm run build` (`tsc`, from the repo root or from `MCP/`). No
  lint command or config exists in this repo yet.

## Non-negotiable rules, in priority order

### 1. Never state a hardware/software fact you haven't verified
Manuals live in `MCP/Documents/`. Before writing code, docs, or an answer that depends on
a specific fact — register addresses, memory maps, GIME behavior, BASIC token values,
disk/cassette formats, MAME driver flags, OS-9 syscalls — **search `MCP/Documents/`
(see `DOCS_INDEX.md`) first.**

- Found it: cite the manual and section/page inline (e.g. `// GIME $FF98 (MMU register),
  Color Computer 3 Service Manual §5.3`).
- Didn't find it: say so explicitly. Don't fill the gap with a plausible-sounding guess.
  Ask the user, search the web for the primary source, or mark the code
  `// TODO: unverified — needs manual confirmation`.
- Treat anything you "remember" about 6809/GIME internals as a hypothesis, not a source,
  until it's checked against the manuals.

### 2. Tests are the spec. Never edit a test to make it pass.
- A failing test gets fixed in the implementation — never by changing the test's
  assertions, expected values, mocks, skips, or by deleting it.
- The only acceptable reason to touch a test is that it's provably wrong (contradicts a
  manual, or has an unrelated setup bug). Even then: **stop, explain why in plain terms
  with a citation, and get explicit human approval before changing it.** Never do this
  silently or bundle it into a "fix."
- Don't loosen an assertion, add unwarranted tolerance, or `.skip`/`xfail` a test to
  reach 100% pass rate. A gutted test isn't a passing test.
- If you're stuck, report that honestly instead of forcing green.

Full policy with examples: `TESTING_POLICY.md`.

### 3. Be efficient
- Search targeted terms inside `MCP/Documents/` and the codebase rather than dumping
  whole manuals or files into context.
- Once a fact is pulled and cited in this session, reuse it — don't re-fetch it.
- Make the smallest diff that correctly fixes the issue; don't refactor unrelated code
  in the same change.
- Run a scoped test for a small change; run the full suite before calling a task done.

## Workflow for hardware-accuracy-sensitive changes
1. Identify exactly which hardware/software fact(s) the change depends on.
2. Search `MCP/Documents/` (`DOCS_INDEX.md` says which manual to check).
3. Implement, citing the source inline.
4. Write/extend a test that encodes the verified behavior — not just current output.
5. Run tests. Failures get fixed in the implementation (Rule 2).
6. Can't verify a fact locally? Flag it explicitly rather than guessing.

## Related documents
- `DOCS_INDEX.md` — what's in `MCP/Documents/` and how to search it efficiently
- `TESTING_POLICY.md` — full test-integrity policy, with allowed/not-allowed examples
- `.claude/rules/` — enforced Cursor rules: integrity, testing, hardware accuracy, MCP conventions
- `.claude/skills/coco3-manual-lookup/SKILL.md` — how to look up CoCo3/MAME facts before answering
