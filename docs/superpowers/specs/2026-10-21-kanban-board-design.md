# Kanban board in mTerm

## Goal

A per-project Kanban board inside mTerm for to-do items: tasks, bugs, features and epics.
People and Claude Code sessions share the same board.
Claude uses it through a built-in `vboard` command and an mTerm Skill, not MCP.

## Board

- One board per project.
- Opens as a center tab, next to terminals.
- Opened from the project's right-click menu and a board icon on the project row.
- Uses the mTerm theme (light and dark) and its system monospace font.

### Columns

- Fixed: Backlog, To Do, In Progress, Review, Done.
- Review can be switched on or off per board.

### Cards

- Number, unique per project (#1, #2…).
- Type: Task, Bug, Feature or Epic.
- Type is a label with its own icon; epics do not group other cards.
- Title and description.
- Priority: Low, Medium, High or Urgent.
- Tags.
- Last change: who (you or a Claude session) and when.

### Top bar

- Search as you type, over title, description and tags.
- Type filter.
- Tag filter (one or more tags).
- Review on/off switch.
- "+ Card" button.

### Card details

- Edit all fields.
- Notes thread, from you and Claude.
- Change history.
- "Send to Claude" button.

### Moving cards

- Drag between columns and within a column.
- Or use "Move to…" in the card menu.

## Claude Code

### `vboard` command

| Command | Does |
|---|---|
| `list [--column --type --tag --search]` | List cards |
| `show N` | One card with notes |
| `add "title" [--type --desc --priority --tag --column]` | New card, To Do by default |
| `edit N` | Change fields |
| `tag N +a -b` | Add or remove tags |
| `move N <column>` | Move a card |
| `note N "text"` | Add a note |
| `next` | Take the top To Do card |
| `done N "summary"` | Finish a card |
| `delete N` | Delete a card |

### Rules

- The project comes from the terminal's session, so Claude needs no board id or password.
- `next` takes the top To Do card by priority, then position.
- `next` moves it to In Progress and marks it as taken by that session.
- Two sessions can never take the same card.
- `done` moves the card to Review when Review is on, otherwise to Done.
- With Review on, Claude cannot move cards to Done; only you can, in the board.

### Skill

- Claude can use it on its own, like `vstat`.
- Teaches the flow: `next`, do the work, add notes, `done`.
- Prefer moving to Done over deleting.

### Send to Claude

- Start a new Claude session in the project with the card as its first instruction.
- The card moves to In Progress, taken by that session.
- Or send the card to an existing session you pick.

## Behind the scenes

- New database tables for boards, cards, tags, notes and history.
- Backend module `src-tauri/src/board/`, with the rules, app commands, the `vboard` endpoint and command.
- Wired in like `vtell` and `vkb`.
- Every change sends a `board://changed` event, and an open board refreshes at once.
- Frontend folder `src/layout/Board/`, plus `src/ipc/board.ts`.
- Board tabs sit beside document, browser and task tabs.

## Errors

- `vboard` returns plain messages: card not found, Review is on, app not running.
- The board checks input in place and saves nothing that is invalid.

## Out of scope

- Epic grouping, due dates, colours, checklists.
- Calendar and timeline views, export.
- Custom columns, board passwords.
- "Search cards" and "board brief".

## Testing

- Backend: taking cards (no double take), Review rule, numbering, type and tag filters, search.
- Board: search, filters, moving cards, details form.
- In the app: create cards, then from a Claude terminal run `vboard next`, `note` and `done`, and watch the board update.
