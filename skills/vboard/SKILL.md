---
name: vboard
description: >-
  You CAN read and update this project's Kanban board in mTerm. Cards are tasks, bugs, features and
  epics in the columns Backlog, To Do, In Progress, Review and Done. Use it when the user mentions the
  board, cards, a to-do list, tracking a bug or feature, "do the next task", "work through the board",
  "add this to the board", or asks what is planned or in progress, in any language. Available only
  inside mTerm-hosted sessions; the board is the one for the project this session belongs to.
argument-hint: "list | show N | add \"title\" | next | note N \"text\" | done N \"summary\" | move N <column>"
allowed-tools: Bash(vboard:*)
---

# vboard

`vboard` reads and changes the Kanban board of this session's project.
People see your changes live in the board tab, marked with this session's name.

## Working through the board

1. `vboard next` takes the top To Do card (highest priority first), moves it to In Progress and marks it as yours.
   If it prints `"card": null`, To Do is empty: tell the user.
2. Do the work the card describes.
3. Add short notes as you go, especially for decisions and blockers: `vboard note 12 "Blocked: needs an API key"`.
4. Finish with `vboard done 12 "What changed and how it was checked"`.
   When the board has a Review column, the card goes there and a person moves it to Done.
   Never move a card to Done yourself while there is a Review column; `vboard` refuses it.

When the user names a card ("work on #7"), use `vboard show 7` first, then `vboard move 7 in_progress` and add a note that you are on it.

## Columns

People can rename, reorder, add and delete columns, so run `vboard columns` when unsure.
`next` and `done` always use the standard To Do, In Progress, Review and Done columns, whatever they are called.
Name a column by its name (`"QA"`, `"In Progress"`) or a standard role (`todo`, `in_progress`, `review`, `done`).

## Rules

- Never guess card numbers: run `vboard list` (or `vboard list --search "login"`) first.
- Finish with `done`; delete only when the user asks.
- Keep titles short; put details in `--desc`.
- Use the type that fits: `task`, `bug`, `feature` or `epic`.
- Tags are short lowercase words, for example `ui`, `auth`, `perf`.
- Colours are optional: `red`, `orange`, `yellow`, `green`, `blue`, `purple`, `pink`, or `none` to clear.

## Commands

```bash
vboard columns                                # the board's columns and card counts
vboard list                                   # every card
vboard list --column todo --type bug          # filter by column, type, tag or text
vboard list --tag ui --search "dark mode"
vboard show 12                                # one card with notes and history
vboard add "Fix login crash" --type bug --priority high --tag auth,ui --color red --desc "Crashes on empty password"
vboard edit 12 --priority urgent --title "Fix login crash on Windows"
vboard tag 12 +regression -ui                 # add and remove tags
vboard move 12 "QA"                           # any column name or role
vboard note 12 "Reproduced with an empty password"
vboard next                                   # take the top To Do card
vboard done 12 "Guarded the empty password; added a test"
vboard delete 12                              # only when asked
```

Output is JSON. Errors are plain sentences on stderr with exit code 1.
If it says "Run vboard inside an mTerm session", this shell is not an mTerm session; tell the user instead of retrying.
