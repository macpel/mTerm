# Kanban Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-project Kanban board tab in mTerm, shared by people and Claude Code through a `vboard` command and skill.

**Architecture:** A new Rust module `board` owns the SQLite tables and every rule; the app UI reaches it through `board_*` commands and Claude through a `/board` loopback endpoint behind the `vboard` shim.
Every write emits `board://changed`; the React board tab refetches on it.
Board tabs live in `termStore` beside task tabs and are not persisted.

**Tech Stack:** Rust (rusqlite, tiny_http, ureq), React + TypeScript, Zustand store, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-21-kanban-board-design.md`

## Global Constraints

- Columns are exactly `backlog`, `todo`, `in_progress`, `review`, `done` (labels: Backlog, To Do, In Progress, Review, Done).
- Types are exactly `task`, `bug`, `feature`, `epic`; priorities exactly `low`, `medium`, `high`, `urgent` (default `medium`).
- Card numbers are unique per project and never reused.
- Look: existing theme tokens (`--bg-*`, `--text*`, `--border*`, `--accent*`) and the app's monospace font; no new colours except one icon tint per type.
- Every user-visible string goes through i18n, and every new key is added to all 11 files in `src/i18n/locales/` (`en.ts` defines the type; the others fail `tsc` without it).
- Rust tests cannot run on this Windows machine (`STATUS_ENTRYPOINT_NOT_FOUND`); Rust verification is `cargo check --lib --tests` (run with `%USERPROFILE%\.cargo\bin` on PATH), plus the dev-app check in Task 9.
- Commit after each task; do not push.

## Review Focus

- Two Claude sessions run `vboard next` at the same moment: each card goes to exactly one session (Task 1 test `claim_next_never_hands_out_a_card_twice`).
- Review is on and Claude runs `vboard move 5 done`: refused with a plain message, while the user can still drag to Done (Task 1 test `agent_cannot_move_to_done_while_review_on`).
- Review is switched off while cards sit in Review: those cards must not disappear (Task 6 test `keeps_review_column_while_it_holds_cards`).
- Tags typed as `UI `, `ui` and `Ui`: one tag `ui`, no duplicates (Task 1 test `tags_are_trimmed_lowercased_and_deduplicated`).
- A project that has never had a board, opened from the UI or `vboard`: board is created on first use, empty, Review off (Task 1 test `board_is_created_on_first_use`).

---

### Task 1: Board data and rules (Rust)

**Files:**
- Create: `src-tauri/src/board/mod.rs` (types, `init`, `dispatch`), `src-tauri/src/board/store.rs` (all SQL and rules), `src-tauri/src/board/tests.rs`
- Modify: `src-tauri/src/lib.rs` (`mod board;`), `src-tauri/src/db/mod.rs:56` (call `crate::board::init(&conn)?` after `knowledge::init`), `src-tauri/src/web/dispatch.rs:~224` (route `board_` prefix), `src-tauri/src/web/ws.rs:269` (add `"board://changed"` to `full_events`, bump the array length)

**Interfaces:**
- Produces (Rust):
  - `pub enum Actor { User, Agent(String /*session id*/) }`
  - `store::get_board(conn, project_id) -> Result<Value>` → `{ reviewEnabled, cards: [Card] }`
  - `store::create_card(conn, project_id, NewCard, &Actor) -> Result<Value /*Card*/>`
  - `store::update_card(conn, project_id, number, CardPatch, &Actor) -> Result<Value>`
  - `store::move_card(conn, project_id, number, column, before_number: Option<i64>, &Actor) -> Result<Value>`
  - `store::delete_card(conn, project_id, number, &Actor) -> Result<()>`
  - `store::add_note(conn, project_id, number, text, &Actor) -> Result<Value>`
  - `store::card_detail(conn, project_id, number) -> Result<Value>` → Card plus `notes`, `history`
  - `store::set_review(conn, project_id, enabled) -> Result<()>`
  - `store::claim(conn, project_id, number, session_id) -> Result<Value>`
  - `store::claim_next(conn, project_id, session_id) -> Result<Option<Value>>`
  - `store::finish(conn, project_id, number, session_id, summary) -> Result<Value>`
  - `store::list(conn, project_id, ListFilter{column,type_,tag,search}) -> Result<Vec<Value>>`
- Card JSON (camelCase): `{ id, number, column, position, type, title, description, priority, tags: string[], claimedBy: string|null, claimedByName: string|null, updatedAt: number /*unix s*/, updatedBy: { kind: "user"|"agent", sessionId: string|null, name: string|null } }`
- App commands (`dispatch`), all with `projectId`; each write emits `board://changed` with `{ projectId }` and runs as `Actor::User`:
  `board_get`, `board_card_create {title,type,description,priority,tags,column}`, `board_card_update {number, title?, type?, description?, priority?, tags?}`, `board_card_move {number, column, beforeNumber?}`, `board_card_delete {number}`, `board_note_add {number, text}`, `board_card_detail {number}`, `board_set_review {enabled}`, `board_claim {number, sessionId}`.

Tables (in `store.rs` as `pub const SCHEMA`):
- `board_boards(project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE, review_enabled INTEGER NOT NULL DEFAULT 0, next_number INTEGER NOT NULL DEFAULT 1)`
- `board_cards(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, number INTEGER NOT NULL, column_id TEXT NOT NULL, position REAL NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', priority TEXT NOT NULL DEFAULT 'medium', claimed_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_kind TEXT NOT NULL, updated_session TEXT, UNIQUE(project_id, number))`
- `board_card_tags(card_id TEXT NOT NULL REFERENCES board_cards(id) ON DELETE CASCADE, tag TEXT NOT NULL, PRIMARY KEY(card_id, tag))`
- `board_notes(id TEXT PRIMARY KEY, card_id TEXT NOT NULL REFERENCES board_cards(id) ON DELETE CASCADE, author_kind TEXT NOT NULL, author_session TEXT, text TEXT NOT NULL, created_at INTEGER NOT NULL)`
- `board_history(id TEXT PRIMARY KEY, card_id TEXT NOT NULL REFERENCES board_cards(id) ON DELETE CASCADE, actor_kind TEXT NOT NULL, actor_session TEXT, action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL)`

Rules `store.rs` must enforce:
- Board row is created on first use by any function (`INSERT OR IGNORE`).
- New card: `number = next_number`, then `next_number + 1`; position = max in column + 1; default column `todo`.
- Title 1–200 chars after trim; description ≤ 20 000; note 1–4 000; invalid enum values rejected.
- Tags: trim, lowercase, 1–32 chars, no commas, deduplicated, at most 10 per card.
- Move: `beforeNumber` given → position halfway between that card and the one above it; else end of column.
- `Actor::Agent` moving to `done` while Review is on → `Err("Review is on: use vboard done; a person moves cards to Done.")`.
- `claim_next`: in one `BEGIN IMMEDIATE` transaction, pick the `todo` card ordered by priority (urgent, high, medium, low) then position, move it to `in_progress`, set `claimed_by`; `None` when To Do is empty.
- `finish`: to `review` if Review is on, else `done`; summary becomes a note; clears nothing else.
- Every change writes a `board_history` row (`created`, `moved`, `edited`, `tagged`, `noted`, `claimed`, `deleted`) and sets `updated_*`.
- `claimedByName` / `updatedBy.name` come from `sessions.name` by join.
- Errors are plain sentences, e.g. `Card #12 not found.`

- [ ] **Step 1: Write the failing tests in `board/tests.rs`** using an in-memory connection set up with `crate::db::schema::SCHEMA` plus `board::init`, one project row and two session rows. Tests (each asserts the stated values):
  - `board_is_created_on_first_use`: `get_board` on a fresh project → `reviewEnabled == false`, `cards == []`.
  - `numbers_increase_and_are_never_reused`: create #1, #2, delete #2, create → number 3.
  - `tags_are_trimmed_lowercased_and_deduplicated`: tags `["UI ", "ui", "Ui", "bug"]` → `["bug","ui"]`.
  - `move_places_card_before_target`: cards #1,#2,#3 in todo; move #3 before #1 → order #3,#1,#2.
  - `agent_cannot_move_to_done_while_review_on`: review on; agent move → error text above; `Actor::User` move → ok.
  - `claim_next_takes_highest_priority_then_position`: #1 medium, #2 urgent, #3 urgent (after #2) → claims #2, then #3, then #1, then `None`.
  - `claim_next_never_hands_out_a_card_twice`: two `Connection`s on one temp-file DB, two threads calling `claim_next` 20 times over 10 cards → 10 distinct numbers, no repeats.
  - `finish_goes_to_review_or_done`: review on → `review`; off → `done`; summary present in notes.
  - `list_filters_by_column_type_tag_and_search`: search is case-insensitive over title, description, tags.
  - `history_records_actor`: agent move → history row `actor_kind == "agent"`, `actor_session == sid`.
- [ ] **Step 2:** Run `cargo check --lib --tests` → fails (module missing).
- [ ] **Step 3:** Implement `board/mod.rs`, `board/store.rs`, wiring in `lib.rs`, `db/mod.rs`, `web/dispatch.rs`, `web/ws.rs`.
- [ ] **Step 4:** Run `cargo check --lib --tests` → `Finished`, no errors (and `cargo test --lib board::` where tests can run).
- [ ] **Step 5:** Commit `feat(board): board tables, rules and app commands`.

### Task 2: `vboard` command for Claude

**Files:**
- Create: `src-tauri/src/board/agent.rs` (`handle`, `run`, argument parsing)
- Modify: `src-tauri/src/agent/server.rs:~534` (route `/board` like `/knowledge`), `src-tauri/src/main.rs:~89` (`Some("--board") => velaterm_lib::run_board(&args)`), `src-tauri/src/lib.rs:~439` (`pub fn run_board`), `src-tauri/src/agent/spawn_cli.rs:22` (`("vboard","--board")` in `SHIMS`)

**Interfaces:**
- Consumes: Task 1 `store::*`, `Actor::Agent(session_id)`.
- Produces: `POST /board` with Bearer token, body `{ sessionId, args: string[] }` → `{ result }` or `{ error }`; project = session's `project_id` (`db::repo::get_session`), unknown session → `Run vboard inside an mTerm session.`
- `pub fn parse(args: &[String]) -> Result<BoardCommand, String>` (pure, testable): subcommands `list [--column C] [--type T] [--tag T] [--search Q]`, `show N`, `add "title" [--type T] [--desc D] [--priority P] [--tag a,b] [--column C]`, `edit N [--title --type --desc --priority]`, `tag N +a -b`, `move N <column>`, `note N "text"`, `next`, `done N "summary"`, `delete N`, `help`. `N` accepts `12` or `#12`.
- Output: pretty JSON like `vkb`; `next` with nothing left prints `{"card":null,"message":"To Do is empty."}`.
- Messages: outside a session → `Run vboard inside an mTerm session.`; endpoint unreachable → `Cannot reach mTerm. Is the app running?`; errors exit with code 1.

- [ ] **Step 1:** Tests in `board/tests.rs`: `parse_accepts_hash_numbers` (`["show","#12"]` → `Show(12)`), `parse_rejects_unknown_column` (`move 3 doing` → error naming the five columns), `parse_tag_changes` (`tag 4 +ui -bug` → add `["ui"]`, remove `["bug"]`).
- [ ] **Step 2:** `cargo check --lib --tests` → fails.
- [ ] **Step 3:** Implement `agent.rs` by copying the shape of `knowledge/agent.rs` (`handle` with Bearer check, 16 KiB body cap; `run` reading `VLX_SPAWN_URL`, `VLX_SESSION_ID`, `VLX_TOKEN`, loopback-only URL check); writes emit `board://changed`.
- [ ] **Step 4:** `cargo check --lib --tests` passes.
- [ ] **Step 5:** Commit `feat(board): vboard command`.

### Task 3: `vboard` skill

**Files:**
- Create: `skills/vboard/SKILL.md`
- Modify: `src-tauri/src/agent/spawn_cli.rs:58` (`("vboard", include_str!("../../../skills/vboard/SKILL.md"))`), `src/components/VelaSkillsModal.tsx:24` (`["vboard","skills.vboard"]`), all locale files (`skills.vboard`: en "Plan and track work on the project's Kanban board.")

Skill content (model-invocable: no `disable-model-invocation`, like `skills/vstat/SKILL.md`):
- When: user mentions the board, cards, tasks/bugs/features to track, "next task", "work through the board".
- Flow: `vboard next` → do the work → `vboard note N` for progress or blockers → `vboard done N "what changed"`.
- With Review on, never try to move to Done; a person reviews.
- Prefer `done` or `move N done` over `delete`; never guess numbers — `vboard list` first.
- Full command list with one example each.

- [ ] **Step 1:** Write the skill, matching frontmatter style of `skills/vstat/SKILL.md`.
- [ ] **Step 2:** `pnpm exec tsc --noEmit -p .` and `cargo check --lib` pass.
- [ ] **Step 3:** Commit `feat(board): vboard skill`.

### Task 4: Frontend data layer

**Files:**
- Create: `src/ipc/board.ts`, `src/layout/Board/filter.ts`, `src/layout/Board/filter.test.ts`

**Interfaces:**
- Produces (TS):
  - Types `BoardColumn`, `CardType`, `Priority` (string unions of the constants above), `BoardCard` (Card JSON), `BoardData { reviewEnabled: boolean; cards: BoardCard[] }`, `CardDetail = BoardCard & { notes: {id,authorKind,authorName,text,createdAt}[]; history: {id,actorKind,actorName,action,detail,createdAt}[] }`.
  - Wrappers named after each command: `boardGet`, `boardCardCreate`, `boardCardUpdate`, `boardCardMove`, `boardCardDelete`, `boardNoteAdd`, `boardCardDetail`, `boardSetReview`, `boardClaim` (pattern: `src/ipc/memory.ts`).
  - `onBoardChanged(projectId, cb): Promise<() => void>` using `listen` from `src/ipc/transport.ts`, filtering on payload `projectId`.
  - `filterCards(cards, { query, types, tags }): BoardCard[]` — query case-insensitive over title, description and tags; a card passes the type filter if its type is selected (or none selected); passes the tag filter if it has **any** selected tag (or none selected).
  - `allTags(cards): string[]` — sorted, unique.
- [ ] **Step 1:** `filter.test.ts`: `matches query in description`, `type filter ORs selected types`, `tag filter matches any selected tag`, `empty filters return all cards`, `allTags is sorted and unique`.
- [ ] **Step 2:** `pnpm exec vitest run src/layout/Board/filter.test.ts` → fails.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same command → pass.
- [ ] **Step 5:** Commit `feat(board): frontend board client and filters`.

### Task 5: Board tab plumbing and entry points

**Files:**
- Modify: `src/store/termStore.ts` (type `BoardTab { id: "board-" + projectId; projectId: string }`, state `boardTabs`, action `openBoardTab(projectId)`), every place that checks `taskTabs` for "tab without a pane tree" (`termStore.ts` `reconcileTabs` ~692-765, `closeTab` ~2989, active-tab checks ~2940/4246; `src/store/mirrorLayout.ts:223`; `src/hooks/useKeyboardShortcuts.ts:56,87,144`; `src/layout/CenterPane/CenterPane.tsx:~422`; `src/layout/CenterPane/TabBar.tsx:~425`), `src/layout/LeftSidebar/LeftSidebar.tsx:~715` (project menu item "Board"), `src/layout/LeftSidebar/ProjectTree.tsx` (board icon on the project row's hover actions), `src/components/Icons.tsx` (`board` icon), locales (`board.title`, `tree.openBoard`).
- Test: `src/store/boardTabs.test.ts`

**Interfaces:**
- Produces: `openBoardTab(projectId: string): void` — focuses the existing `board-<projectId>` tab or opens one; tab label `Board · <project name>`; `BoardView` placeholder component rendered by `CenterPane` for board tabs (Task 6 fills it).
- [ ] **Step 1:** `boardTabs.test.ts`: `opens one tab per project` (second call focuses, no duplicate), `closeTab removes the board tab`, `reconcileTabs keeps an open board tab`.
- [ ] **Step 2:** `pnpm exec vitest run src/store/boardTabs.test.ts` → fails.
- [ ] **Step 3:** Implement, following how `taskTabs` is handled in each listed place.
- [ ] **Step 4:** Test passes; `pnpm exec tsc --noEmit -p .` passes.
- [ ] **Step 5:** Commit `feat(board): board tabs and entry points`.

### Task 6: Board view

**Files:**
- Create: `src/layout/Board/BoardView.tsx` (loads data, top bar, columns), `src/layout/Board/BoardColumn.tsx`, `src/layout/Board/BoardCard.tsx`, `src/layout/Board/board.css`, `src/layout/Board/BoardView.test.tsx`
- Modify: locales (column names, type names, priority names, `board.search`, `board.review`, `board.addCard`, `board.empty`, `board.byYou`, `board.bySession`)

**Interfaces:**
- Consumes: Task 4 wrappers, `filterCards`, `allTags`, `onBoardChanged`; Task 5 `BoardTab`.
- Produces: `<BoardView projectId />`; clicking a card calls `onOpenCard(number)` (Task 7).

Behaviour:
- Columns in order; Review shown when `reviewEnabled` **or** any card is in `review`.
- Card shows `#N`, type icon, title, priority marker, tag chips, "You · 2h ago" / "<session name> · 5m ago", and "Taken by <session>" when claimed.
- Drag and drop with HTML5 DnD (as in `TabBar.tsx` reordering): drop between cards → `boardCardMove` with `beforeNumber`; card menu "Move to…" lists columns.
- Top bar: search input, type chips, tag chips (from `allTags`), Review switch (`boardSetReview`), "+ Card" (opens Task 7 form).
- Refetch on `onBoardChanged`.
- [ ] **Step 1:** `BoardView.test.tsx` with mocked `src/ipc/board.ts`: `renders columns and cards`, `keeps_review_column_while_it_holds_cards` (review off, one card in review → Review column visible), `search narrows cards`, `tag chip filters`, `Move to calls boardCardMove`, `refetches on board changed event`.
- [ ] **Step 2:** Run → fails.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Tests pass; `tsc` and `eslint src/layout/Board` clean.
- [ ] **Step 5:** Commit `feat(board): board view with search, filters and drag and drop`.

### Task 7: Card details and new-card form

**Files:**
- Create: `src/layout/Board/CardDetails.tsx` (side panel inside the board tab), `src/layout/Board/CardDetails.test.tsx`
- Modify: `BoardView.tsx` (open/close panel, "+ Card" opens it empty), locales (`board.title*`, `board.notes`, `board.history`, `board.addNote`, `board.delete`, `board.deleteConfirm`, history action names)

**Interfaces:**
- Consumes: `boardCardDetail`, `boardCardCreate`, `boardCardUpdate`, `boardNoteAdd`, `boardCardDelete`.
- Produces: `<CardDetails projectId number?={n} onClose />`; new card when `number` is undefined.

Behaviour: fields title (required), type, priority, description, tags (type and Enter adds a chip); Save disabled while title empty, inline error from the backend shown under the form; notes thread with add box; history list (newest first); Delete asks to confirm.
- [ ] **Step 1:** Tests: `creates a card with type, priority and tags`, `save disabled without title`, `shows backend error inline`, `adds a note`, `lists history newest first`.
- [ ] **Step 2:** Run → fails.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Tests pass.
- [ ] **Step 5:** Commit `feat(board): card details, notes and history`.

### Task 8: Send to Claude

**Files:**
- Create: `src/layout/Board/sendToClaude.ts`, `src/layout/Board/sendToClaude.test.ts`
- Modify: `src/store/termStore.ts` (action `setPendingPrompt(sessionId, text)`; `pendingPrompts` is already read by `takePendingPrompt` at ~2451 and passed to `ptySpawn` as `initialPrompt`), `CardDetails.tsx` (button + menu: "New Claude session" and the project's existing Claude sessions), locales (`board.sendToClaude`, `board.newSession`)

**Interfaces:**
- Consumes: `createSession` (`src/ipc/tree.ts:101`), `defaultEngineFor` (`src/store/settings.ts:61`), `chatSend` (`src/ipc/chat.ts:768`), `ptyWrite` (`src/ipc/commands.ts:36`), `openSession`, `boardClaim`.
- Produces: `cardPrompt(card): string` and `sendCardToClaude(card, projectId, target: "new" | Session): Promise<void>`.

`cardPrompt` text (exact): `Work on board card #<n> (<type>, <priority>): <title>\n\n<description>\n\nUse vboard to add notes and run "vboard done <n> \"<summary>\"" when finished.` (description block omitted when empty).

Flow: new → `createSession({ projectId, kind: "claude", name: "#<n> <title>" (max 60 chars), engine: defaultEngineFor(...) })`, `boardClaim(number, session.id)`, then TUI: `setPendingPrompt` + `openSession`; chat: `openSession` + `chatSend(id, prompt, "queue")`.
Existing → `boardClaim`, then chat: `chatSend(id, prompt, "queue")`; TUI: `ptyWrite(id, prompt + "\r")`; then `openSession(id)`.
- [ ] **Step 1:** Tests with mocked ipc: `cardPrompt includes number, type, priority and done hint`, `new TUI session gets the prompt as its first launch prompt`, `new chat session gets the prompt via chatSend queue`, `existing session is claimed before sending`.
- [ ] **Step 2:** Run → fails.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Tests pass.
- [ ] **Step 5:** Commit `feat(board): send a card to Claude`.

### Task 9: End-to-end check in the app

- [ ] **Step 1:** `pnpm exec tsc --noEmit -p .`, `pnpm exec eslint src/layout/Board src/ipc/board.ts`, `pnpm exec vitest run` (alone, no parallel cargo); `cargo check --lib --tests`.
- [ ] **Step 2:** `pnpm dev:desktop board` (cargo on PATH, `CARGO_BUILD_JOBS=4`). Create a project, open its board from the right-click menu, add a Bug, a Feature and a Task with tags; search; filter by type and tag; drag a card; switch Review on.
- [ ] **Step 3:** Install mTerm Skills from the status bar; in a Claude session of that project ask "do the next task on the board". Expect: card to In Progress taken by that session, a note, then Review; board updates without reload.
- [ ] **Step 4:** From the board, "Send to Claude" → new session; it starts on the card.
- [ ] **Step 5:** Commit any fixes `fix(board): …`; report results with screenshots.
