# AGENTS.md — workspace instructions

This file is the workspace's source of truth. Any agent working here reads it first and comes
back to it whenever a process question comes up.

## Reading order at the start of a session

1. `AGENTS.md` (this file) — rules and process.
2. `notes.md` — the project's real state: progress, decisions, changes to the codebase.
3. `to-myself.md` — a personal note across sessions. Always read it, update it when warranted.
4. `findings/` — earlier research. Check before investigating something again.

Only this file and `CLAUDE.md` are tracked in the repository. The other three are working
material and stay out of it, so a fresh clone will not have them.

## Process

1. **Research** — survey options, technical constraints, limits, costs, licences.
2. **Assess viability** — compare alternatives with explicit criteria and trade-offs.
3. **Decide** — record the decision and its rationale in `notes.md`.
4. **Build** — only once a decision is on record.

Don't jump from the question to the code. If information is missing to decide, ask.

## `findings/`

Everything turned up during research goes here. One file per topic.

- Name: `YYYY-MM-DD-topic-in-kebab-case.md`.
- Contents: what was investigated, what was found, what was ruled out and why, what is still open.
- **Every factual claim about the outside world carries a link to its source** (prices, service
  limits, tool behaviour, benchmarks, regulation). If there is no verifiable source, say so
  instead of asserting.
- Always distinguish: verified against a source / tested locally / hypothesis.
- Findings are not rewritten to look good. If something turned out to be false, correct it and
  leave the correction on record.

## `notes.md`

The entry-point reference, second only to this file. Updated **actively during and between
sessions**.

It holds: tasks taken on, implementations, changes made to the codebase, decisions taken, open
problems and the next step. Dated entries, newest first. Concrete and verifiable, no claims.

## `to-myself.md`

The agent's personal note across sessions. Read at the start, updated as the project moves.

Short motivational lines and brief notes on how the work is going. Its purpose is to remember
that regardless of mood or how stuck the problem is, progress is made in good spirits:
**keep on keeping on 👍**.

## Working rules

- **Language**: everything in the repository — code, comments, error messages, interface,
  instructions — is written in English. Conversation with the user, and the working material kept
  out of the repository (`notes.md`, `to-myself.md`, `findings/`), stay in neutral Spanish.
- **No claims**: never write "production ready", "solved", "N times faster" or the like without
  concrete evidence. Report what was actually tested and how.
- **Code comments**: only technical guidance useful for modifying or debugging. No comments that
  describe the obvious or narrate changes ("now fixes X").
- **Quotes**: single in Python, double in JavaScript/TypeScript.
- **Tests**: no tests are written unless the user explicitly asks.
- **`.env`**: never modified. If a variable is needed, tell the user.
- **Secrets**: never requested, never reproduced, never written into code, notes or findings.
  Reference them by name from a secrets manager.
- **Documentation**: the only markdown in the workspace is `AGENTS.md`, `CLAUDE.md`, `notes.md`,
  `to-myself.md` and the files under `findings/`. No reports, usage guides or extra summaries are
  generated.
- **Ask before assuming**: if the goal, scope or constraints are missing, or there is more than
  one reasonable reading that would change the work, ask before building.
- **Point at problems**: if a plan has a serious flaw, say so plainly and offer an alternative
  with explicit trade-offs.
