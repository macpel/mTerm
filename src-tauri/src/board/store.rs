//! Board tables and rules. Every function takes a plain connection so tests run on an in-memory database;
//! callers emit `board://changed` after writes.
//!
//! A board belongs to a folder, not to a project row: tables are keyed by `board_key`, the project's canonical
//! folder path (see `folder_key`), with no foreign key to `projects`. Removing a project from the sidebar
//! therefore keeps its board, and adding the same folder again brings it back.

use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

pub type Result<T> = std::result::Result<T, String>;

/// Roles of the standard columns, in their default order. A role tells `vboard next/done` which column means
/// what, whatever the column is called; custom columns have none.
pub const ROLES: [&str; 5] = ["backlog", "todo", "in_progress", "review", "done"];
pub const COLORS: [&str; 7] = ["red", "orange", "yellow", "green", "blue", "purple", "pink"];

/// English name of a standard column; the app shows its own translation, `vboard` and messages use this.
pub fn role_name(role: &str) -> &'static str {
    match role {
        "backlog" => "Backlog",
        "todo" => "To Do",
        "in_progress" => "In Progress",
        "review" => "Review",
        _ => "Done",
    }
}
pub const TYPES: [&str; 4] = ["task", "bug", "feature", "epic"];
pub const PRIORITIES: [&str; 4] = ["low", "medium", "high", "urgent"];

pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS board_boards (
 board_key TEXT PRIMARY KEY,
 review_enabled INTEGER NOT NULL DEFAULT 0,
 next_number INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS board_cards (
 id TEXT PRIMARY KEY,
 board_key TEXT NOT NULL,
 number INTEGER NOT NULL, column_id TEXT NOT NULL, position REAL NOT NULL,
 type TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
 priority TEXT NOT NULL DEFAULT 'medium', claimed_by TEXT, color TEXT,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 updated_kind TEXT NOT NULL, updated_session TEXT,
 UNIQUE(board_key, number)
);
CREATE TABLE IF NOT EXISTS board_columns (
 board_key TEXT NOT NULL,
 id TEXT NOT NULL, name TEXT, role TEXT, position REAL NOT NULL,
 PRIMARY KEY(board_key, id)
);
CREATE TABLE IF NOT EXISTS board_card_tags (
 card_id TEXT NOT NULL REFERENCES board_cards(id) ON DELETE CASCADE,
 tag TEXT NOT NULL, PRIMARY KEY(card_id, tag)
);
CREATE TABLE IF NOT EXISTS board_notes (
 id TEXT PRIMARY KEY,
 card_id TEXT NOT NULL REFERENCES board_cards(id) ON DELETE CASCADE,
 author_kind TEXT NOT NULL, author_session TEXT, text TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS board_history (
 id TEXT PRIMARY KEY,
 card_id TEXT NOT NULL REFERENCES board_cards(id) ON DELETE CASCADE,
 actor_kind TEXT NOT NULL, actor_session TEXT, action TEXT NOT NULL,
 detail TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
);
";

/// Who made a change: a person in the app, or an agent session.
pub enum Actor {
    User,
    Agent(String),
}

impl Actor {
    fn kind(&self) -> &'static str {
        match self {
            Actor::User => "user",
            Actor::Agent(_) => "agent",
        }
    }
    fn session(&self) -> Option<&str> {
        match self {
            Actor::User => None,
            Actor::Agent(id) => Some(id),
        }
    }
}

/// Fields for a new card. Empty `card_type` means task, empty `priority` means medium, no column means To Do.
#[derive(Default)]
pub struct NewCard {
    pub title: String,
    pub card_type: String,
    pub description: String,
    pub priority: String,
    pub tags: Vec<String>,
    pub column: Option<String>,
    pub color: Option<String>,
}

/// Fields to change; `tags` replaces the whole set.
#[derive(Default)]
pub struct CardPatch {
    pub title: Option<String>,
    pub card_type: Option<String>,
    pub description: Option<String>,
    pub priority: Option<String>,
    pub tags: Option<Vec<String>>,
    /// `""` clears the colour.
    pub color: Option<String>,
}

#[derive(Debug, Default)]
pub struct ListFilter {
    pub column: Option<String>,
    pub type_: Option<String>,
    pub tag: Option<String>,
    pub search: Option<String>,
}

fn db(e: rusqlite::Error) -> String {
    e.to_string()
}

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn one_of(value: &str, allowed: &[&str], what: &str) -> Result<String> {
    if allowed.contains(&value) {
        Ok(value.to_string())
    } else {
        Err(format!("Unknown {what} \"{value}\". Use one of: {}.", allowed.join(", ")))
    }
}

fn clean_title(title: &str) -> Result<String> {
    let title = title.trim();
    if title.is_empty() || title.chars().count() > 200 {
        return Err("Give the card a title of up to 200 characters.".into());
    }
    Ok(title.to_string())
}

fn clean_description(text: &str) -> Result<String> {
    if text.chars().count() > 20_000 {
        return Err("The description is limited to 20,000 characters.".into());
    }
    Ok(text.trim_end().to_string())
}

fn clean_tags(tags: &[String]) -> Result<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    for tag in tags {
        let tag = tag.trim().to_lowercase();
        if tag.is_empty() {
            continue;
        }
        if tag.contains(',') || tag.chars().count() > 32 {
            return Err("Tags are 1 to 32 characters without commas.".into());
        }
        if !out.contains(&tag) {
            out.push(tag);
        }
    }
    if out.len() > 10 {
        return Err("A card can have at most 10 tags.".into());
    }
    out.sort();
    Ok(out)
}

/// The board key for a project folder: its canonical path, or the path as stored when the folder is gone.
pub fn folder_key(root_path: &str) -> String {
    std::path::Path::new(root_path)
        .canonicalize()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| root_path.to_string())
}

fn has_column(conn: &Connection, table: &str, column: &str) -> Result<bool> {
    conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info(?1) WHERE name=?2",
        params![table, column],
        |r| r.get::<_, i64>(0),
    )
    .map(|n| n > 0)
    .map_err(db)
}

/// Tables, plus the upgrades of older databases: cards without a colour, and boards keyed by project id.
pub fn init(conn: &Connection) -> Result<()> {
    conn.execute_batch(SCHEMA).map_err(db)?;
    if !has_column(conn, "board_cards", "color")? {
        conn.execute_batch("ALTER TABLE board_cards ADD COLUMN color TEXT").map_err(db)?;
    }
    let old: Vec<&str> = ["board_boards", "board_columns", "board_cards"]
        .into_iter()
        .filter(|table| has_column(conn, table, "project_id").unwrap_or(false))
        .collect();
    if !old.is_empty() {
        migrate_to_folder_keys(conn, &old)?;
    }
    Ok(())
}

/// The new shape of each project-keyed table, and how its rows are copied across.
fn rebuild_sql(table: &str) -> &'static str {
    match table {
        "board_boards" => {
            "CREATE TABLE board_boards_new (board_key TEXT PRIMARY KEY, review_enabled INTEGER NOT NULL DEFAULT 0, next_number INTEGER NOT NULL DEFAULT 1);
             INSERT OR IGNORE INTO board_boards_new SELECT m.board_key, b.review_enabled, b.next_number
               FROM board_boards b JOIN board_key_map m ON m.project_id = b.project_id;"
        }
        "board_columns" => {
            "CREATE TABLE board_columns_new (board_key TEXT NOT NULL, id TEXT NOT NULL, name TEXT, role TEXT,
               position REAL NOT NULL, PRIMARY KEY(board_key, id));
             INSERT OR IGNORE INTO board_columns_new SELECT m.board_key, c.id, c.name, c.role, c.position
               FROM board_columns c JOIN board_key_map m ON m.project_id = c.project_id;"
        }
        _ => {
            "CREATE TABLE board_cards_new (id TEXT PRIMARY KEY, board_key TEXT NOT NULL, number INTEGER NOT NULL,
               column_id TEXT NOT NULL, position REAL NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL,
               description TEXT NOT NULL DEFAULT '', priority TEXT NOT NULL DEFAULT 'medium', claimed_by TEXT, color TEXT,
               created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_kind TEXT NOT NULL, updated_session TEXT,
               UNIQUE(board_key, number));
             INSERT OR IGNORE INTO board_cards_new SELECT c.id, m.board_key, c.number, c.column_id, c.position, c.type,
               c.title, c.description, c.priority, c.claimed_by, c.color, c.created_at, c.updated_at, c.updated_kind,
               c.updated_session
               FROM board_cards c JOIN board_key_map m ON m.project_id = c.project_id;"
        }
    }
}

/// Rebuild the tables still keyed by project id, keyed by folder instead. Each one is upgraded on its own: a
/// database made before columns existed has old board and card tables but a new column table. SQLite cannot
/// drop a column's foreign key in place, so each table is copied into a new one, dropped and replaced, with
/// foreign keys off so nothing cascades.
fn migrate_to_folder_keys(conn: &Connection, tables: &[&str]) -> Result<()> {
    let enforced: i64 = conn.query_row("PRAGMA foreign_keys", [], |r| r.get(0)).map_err(db)?;
    conn.execute_batch("PRAGMA foreign_keys = OFF;").map_err(db)?;
    let result = (|| -> Result<()> {
        let tx = conn.unchecked_transaction().map_err(db)?;
        tx.execute_batch("CREATE TEMP TABLE board_key_map (project_id TEXT PRIMARY KEY, board_key TEXT NOT NULL)").map_err(db)?;
        let projects: Vec<(String, String)> = {
            let mut stmt = tx.prepare("SELECT id, root_path FROM projects").map_err(db)?;
            let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).map_err(db)?;
            rows.collect::<std::result::Result<_, _>>().map_err(db)?
        };
        for (id, root) in &projects {
            tx.execute("INSERT INTO board_key_map VALUES(?1, ?2)", params![id, folder_key(root)]).map_err(db)?;
        }
        for table in tables {
            tx.execute_batch(rebuild_sql(table)).map_err(db)?;
            tx.execute_batch(&format!("DROP TABLE {table}; ALTER TABLE {table}_new RENAME TO {table};")).map_err(db)?;
        }
        tx.execute_batch(
            "DROP TABLE board_key_map;
             DELETE FROM board_card_tags WHERE card_id NOT IN (SELECT id FROM board_cards);
             DELETE FROM board_notes WHERE card_id NOT IN (SELECT id FROM board_cards);
             DELETE FROM board_history WHERE card_id NOT IN (SELECT id FROM board_cards);",
        )
        .map_err(db)?;
        tx.commit().map_err(db)
    })();
    if enforced != 0 {
        conn.execute_batch("PRAGMA foreign_keys = ON;").map_err(db)?;
    }
    result
}

/// Create the board on first use with the standard columns. Review is added too when the board used the
/// older Review switch or still holds cards in Review.
fn ensure_board(conn: &Connection, board: &str) -> Result<()> {
    conn.execute("INSERT OR IGNORE INTO board_boards(board_key) VALUES(?1)", [board]).map_err(db)?;
    let has_columns: i64 =
        conn.query_row("SELECT COUNT(*) FROM board_columns WHERE board_key=?1", [board], |r| r.get(0)).map_err(db)?;
    if has_columns > 0 {
        return Ok(());
    }
    let review: i64 = conn
        .query_row(
            "SELECT (SELECT review_enabled FROM board_boards WHERE board_key=?1)
                  + (SELECT COUNT(*) FROM board_cards WHERE board_key=?1 AND column_id='review')",
            [board],
            |r| r.get(0),
        )
        .map_err(db)?;
    for (i, role) in ROLES.iter().enumerate() {
        if *role == "review" && review == 0 {
            continue;
        }
        conn.execute(
            "INSERT INTO board_columns(board_key,id,name,role,position) VALUES(?1,?2,NULL,?2,?3)",
            params![board, role, i as f64],
        )
        .map_err(db)?;
    }
    Ok(())
}

/// The column holding a standard role, if the board still has one.
fn role_column(conn: &Connection, board: &str, role: &str) -> Result<Option<String>> {
    ensure_board(conn, board)?;
    conn.query_row("SELECT id FROM board_columns WHERE board_key=?1 AND role=?2", params![board, role], |r| r.get(0))
        .optional()
        .map_err(db)
}

fn column_role(conn: &Connection, board: &str, column: &str) -> Result<Option<String>> {
    conn.query_row("SELECT role FROM board_columns WHERE board_key=?1 AND id=?2", params![board, column], |r| r.get(0))
        .optional()
        .map_err(db)
        .map(Option::flatten)
}

fn check_column(conn: &Connection, board: &str, column: &str) -> Result<()> {
    ensure_board(conn, board)?;
    let found: i64 = conn
        .query_row("SELECT COUNT(*) FROM board_columns WHERE board_key=?1 AND id=?2", params![board, column], |r| r.get(0))
        .map_err(db)?;
    if found == 0 {
        return Err(format!("Column \"{column}\" not found."));
    }
    Ok(())
}

/// With a Review column, only a person puts cards in Done; agents finish through Review.
fn check_review_gate(conn: &Connection, board: &str, column: &str, actor: &Actor) -> Result<()> {
    if matches!(actor, Actor::Agent(_))
        && column_role(conn, board, column)?.as_deref() == Some("done")
        && role_column(conn, board, "review")?.is_some()
    {
        return Err("Review is on: use vboard done; a person moves cards to Done.".into());
    }
    Ok(())
}

fn clean_color(color: &str) -> Result<Option<String>> {
    let color = color.trim().to_lowercase();
    if color.is_empty() || color == "none" {
        return Ok(None);
    }
    one_of(&color, &COLORS, "colour").map(Some)
}

fn card_id(conn: &Connection, board: &str, number: i64) -> Result<String> {
    conn.query_row("SELECT id FROM board_cards WHERE board_key=?1 AND number=?2", params![board, number], |r| r.get(0))
        .optional()
        .map_err(db)?
        .ok_or_else(|| format!("Card #{number} not found."))
}

fn end_position(conn: &Connection, board: &str, column: &str, except: &str) -> Result<f64> {
    conn.query_row(
        "SELECT COALESCE(MAX(position),0)+1 FROM board_cards WHERE board_key=?1 AND column_id=?2 AND id<>?3",
        params![board, column, except],
        |r| r.get(0),
    )
    .map_err(db)
}

/// Record a change on the card and in its history.
fn touch(conn: &Connection, id: &str, actor: &Actor, action: &str, detail: &str) -> Result<()> {
    let at = now();
    conn.execute(
        "UPDATE board_cards SET updated_at=?2, updated_kind=?3, updated_session=?4 WHERE id=?1",
        params![id, at, actor.kind(), actor.session()],
    )
    .map_err(db)?;
    conn.execute(
        "INSERT INTO board_history(id,card_id,actor_kind,actor_session,action,detail,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",
        params![uuid::Uuid::new_v4().to_string(), id, actor.kind(), actor.session(), action, detail, at],
    )
    .map_err(db)?;
    Ok(())
}

fn set_tags(conn: &Connection, id: &str, tags: &[String]) -> Result<()> {
    conn.execute("DELETE FROM board_card_tags WHERE card_id=?1", [id]).map_err(db)?;
    for tag in tags {
        conn.execute("INSERT INTO board_card_tags(card_id,tag) VALUES(?1,?2)", params![id, tag]).map_err(db)?;
    }
    Ok(())
}

/// Every card of the board as JSON, in column order then position.
fn all_cards(conn: &Connection, board: &str) -> Result<Vec<Value>> {
    let mut tags: HashMap<String, Vec<String>> = HashMap::new();
    let mut stmt = conn
        .prepare("SELECT t.card_id, t.tag FROM board_card_tags t JOIN board_cards c ON c.id=t.card_id WHERE c.board_key=?1 ORDER BY t.tag")
        .map_err(db)?;
    let rows = stmt.query_map([board], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).map_err(db)?;
    for row in rows {
        let (card, tag) = row.map_err(db)?;
        tags.entry(card).or_default().push(tag);
    }
    let mut stmt = conn
        .prepare(
            "SELECT c.id, c.number, c.column_id, c.position, c.type, c.title, c.description, c.priority,
                    c.claimed_by, cs.name, c.updated_at, c.updated_kind, c.updated_session, us.name, c.color
             FROM board_cards c
             LEFT JOIN sessions cs ON cs.id=c.claimed_by
             LEFT JOIN sessions us ON us.id=c.updated_session
             WHERE c.board_key=?1",
        )
        .map_err(db)?;
    let rows = stmt
        .query_map([board], |r| {
            let id: String = r.get(0)?;
            Ok(json!({
                "id": id,
                "number": r.get::<_, i64>(1)?,
                "column": r.get::<_, String>(2)?,
                "position": r.get::<_, f64>(3)?,
                "type": r.get::<_, String>(4)?,
                "title": r.get::<_, String>(5)?,
                "description": r.get::<_, String>(6)?,
                "priority": r.get::<_, String>(7)?,
                "claimedBy": r.get::<_, Option<String>>(8)?,
                "claimedByName": r.get::<_, Option<String>>(9)?,
                "updatedAt": r.get::<_, i64>(10)?,
                "updatedBy": {
                    "kind": r.get::<_, String>(11)?,
                    "sessionId": r.get::<_, Option<String>>(12)?,
                    "name": r.get::<_, Option<String>>(13)?,
                },
                "color": r.get::<_, Option<String>>(14)?,
            }))
        })
        .map_err(db)?;
    let mut cards = Vec::new();
    for row in rows {
        let mut card = row.map_err(db)?;
        let id = card["id"].as_str().unwrap_or_default().to_string();
        card["tags"] = json!(tags.remove(&id).unwrap_or_default());
        cards.push(card);
    }
    let order: Vec<String> = columns(conn, board)?.iter().filter_map(|c| c["id"].as_str().map(str::to_string)).collect();
    let rank = |c: &Value| order.iter().position(|col| c["column"] == *col).unwrap_or(order.len());
    cards.sort_by(|a, b| {
        rank(a).cmp(&rank(b)).then(
            a["position"].as_f64().unwrap_or(0.0).partial_cmp(&b["position"].as_f64().unwrap_or(0.0)).unwrap_or(std::cmp::Ordering::Equal),
        )
    });
    Ok(cards)
}

fn card_json(conn: &Connection, board: &str, number: i64) -> Result<Value> {
    all_cards(conn, board)?
        .into_iter()
        .find(|c| c["number"] == number)
        .ok_or_else(|| format!("Card #{number} not found."))
}

pub fn get_board(conn: &Connection, board: &str) -> Result<Value> {
    Ok(json!({ "columns": columns(conn, board)?, "cards": all_cards(conn, board)? }))
}

// ── columns ──

/// The board's columns in order: `{id, name, role, position}`; `name` is null until a standard column is renamed.
pub fn columns(conn: &Connection, board: &str) -> Result<Vec<Value>> {
    ensure_board(conn, board)?;
    let mut stmt = conn
        .prepare("SELECT id, name, role, position FROM board_columns WHERE board_key=?1 ORDER BY position")
        .map_err(db)?;
    let rows = stmt
        .query_map([board], |r| {
            Ok(json!({
                "id": r.get::<_, String>(0)?,
                "name": r.get::<_, Option<String>>(1)?,
                "role": r.get::<_, Option<String>>(2)?,
                "position": r.get::<_, f64>(3)?,
            }))
        })
        .map_err(db)?;
    rows.collect::<std::result::Result<_, _>>().map_err(db)
}

/// Name a column shows outside the app: its own name, or the English name of its role.
pub fn display_name(column: &Value) -> String {
    column["name"].as_str().map(str::to_string).unwrap_or_else(|| role_name(column["role"].as_str().unwrap_or("")).to_string())
}

/// Find a column by id, role (`in_progress`, `in-progress`) or display name, ignoring case.
pub fn resolve_column(conn: &Connection, board: &str, word: &str) -> Result<String> {
    let all = columns(conn, board)?;
    let wanted = word.trim().to_lowercase();
    let role = wanted.replace(['-', ' '], "_");
    all.iter()
        .find(|c| c["id"].as_str() == Some(word.trim()))
        .or_else(|| all.iter().find(|c| c["role"].as_str() == Some(role.as_str())))
        .or_else(|| all.iter().find(|c| display_name(c).to_lowercase() == wanted))
        .and_then(|c| c["id"].as_str().map(str::to_string))
        .ok_or_else(|| {
            let names: Vec<String> = all.iter().map(display_name).collect();
            format!("Column \"{}\" not found. Columns: {}.", word.trim(), names.join(", "))
        })
}

fn clean_column_name(conn: &Connection, board: &str, name: &str, except: &str) -> Result<String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 40 {
        return Err("A column name is 1 to 40 characters.".into());
    }
    let taken = columns(conn, board)?
        .iter()
        .any(|c| c["id"].as_str() != Some(except) && display_name(c).to_lowercase() == name.to_lowercase());
    if taken {
        return Err(format!("A column named \"{name}\" already exists."));
    }
    Ok(name.to_string())
}

fn refuse_backlog(column: &str) -> Result<()> {
    if column == "backlog" {
        return Err("Backlog stays first and cannot be changed.".into());
    }
    Ok(())
}

/// Add a column at the end: a custom one with a name, or a missing standard one by role.
pub fn add_column(conn: &Connection, board: &str, name: Option<&str>, role: Option<&str>) -> Result<Value> {
    ensure_board(conn, board)?;
    let (id, name, role) = match role {
        Some(role) => {
            let role = one_of(role, &ROLES[1..], "column role")?;
            if role_column(conn, board, &role)?.is_some() {
                return Err(format!("The board already has a {} column.", role_name(&role)));
            }
            let name = match name {
                Some(n) => Some(clean_column_name(conn, board, n, "")?),
                None => {
                    clean_column_name(conn, board, role_name(&role), "")?;
                    None
                }
            };
            (role.clone(), name, Some(role))
        }
        None => {
            let name = clean_column_name(conn, board, name.unwrap_or(""), "")?;
            (format!("c-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]), Some(name), None)
        }
    };
    let position: f64 = conn
        .query_row("SELECT COALESCE(MAX(position),0)+1 FROM board_columns WHERE board_key=?1", [board], |r| r.get(0))
        .map_err(db)?;
    conn.execute(
        "INSERT INTO board_columns(board_key,id,name,role,position) VALUES(?1,?2,?3,?4,?5)",
        params![board, id, name, role, position],
    )
    .map_err(db)?;
    columns(conn, board)?.into_iter().find(|c| c["id"] == id.as_str()).ok_or_else(|| "Column not saved.".to_string())
}

pub fn rename_column(conn: &Connection, board: &str, column: &str, name: &str) -> Result<()> {
    refuse_backlog(column)?;
    check_column(conn, board, column)?;
    let name = clean_column_name(conn, board, name, column)?;
    conn.execute("UPDATE board_columns SET name=?3 WHERE board_key=?1 AND id=?2", params![board, column, name]).map_err(db)?;
    Ok(())
}

/// Move a column before `before`, or to the end. Nothing goes before Backlog.
pub fn move_column(conn: &Connection, board: &str, column: &str, before: Option<&str>) -> Result<()> {
    refuse_backlog(column)?;
    check_column(conn, board, column)?;
    let position: f64 = match before {
        Some(target) => {
            refuse_backlog(target)?;
            check_column(conn, board, target)?;
            let target_pos: f64 = conn
                .query_row("SELECT position FROM board_columns WHERE board_key=?1 AND id=?2", params![board, target], |r| r.get(0))
                .map_err(db)?;
            let above: Option<f64> = conn
                .query_row(
                    "SELECT MAX(position) FROM board_columns WHERE board_key=?1 AND position<?2 AND id<>?3",
                    params![board, target_pos, column],
                    |r| r.get(0),
                )
                .map_err(db)?;
            (above.unwrap_or(target_pos - 1.0) + target_pos) / 2.0
        }
        None => conn
            .query_row(
                "SELECT COALESCE(MAX(position),0)+1 FROM board_columns WHERE board_key=?1 AND id<>?2",
                params![board, column],
                |r| r.get(0),
            )
            .map_err(db)?,
    };
    conn.execute("UPDATE board_columns SET position=?3 WHERE board_key=?1 AND id=?2", params![board, column, position])
        .map_err(db)?;
    Ok(())
}

/// Delete a column; its cards move to the end of Backlog and lose their claim.
pub fn delete_column(conn: &Connection, board: &str, column: &str, actor: &Actor) -> Result<()> {
    refuse_backlog(column)?;
    check_column(conn, board, column)?;
    let tx = conn.unchecked_transaction().map_err(db)?;
    let ids: Vec<String> = {
        let mut stmt = tx
            .prepare("SELECT id FROM board_cards WHERE board_key=?1 AND column_id=?2 ORDER BY position")
            .map_err(db)?;
        let rows = stmt.query_map(params![board, column], |r| r.get(0)).map_err(db)?;
        rows.collect::<std::result::Result<_, _>>().map_err(db)?
    };
    for id in &ids {
        place(&tx, board, id, "backlog", None)?;
        tx.execute("UPDATE board_cards SET claimed_by=NULL WHERE id=?1", [id]).map_err(db)?;
        touch(&tx, id, actor, "moved", "backlog")?;
    }
    tx.execute("DELETE FROM board_columns WHERE board_key=?1 AND id=?2", params![board, column]).map_err(db)?;
    tx.commit().map_err(db)?;
    Ok(())
}

pub fn create_card(conn: &Connection, board: &str, card: NewCard, actor: &Actor) -> Result<Value> {
    let title = clean_title(&card.title)?;
    let card_type = one_of(if card.card_type.is_empty() { "task" } else { &card.card_type }, &TYPES, "type")?;
    let priority = one_of(if card.priority.is_empty() { "medium" } else { &card.priority }, &PRIORITIES, "priority")?;
    let column = match card.column {
        Some(column) => column,
        None => role_column(conn, board, "todo")?.unwrap_or_else(|| "backlog".to_string()),
    };
    check_column(conn, board, &column)?;
    let description = clean_description(&card.description)?;
    let tags = clean_tags(&card.tags)?;
    let color = clean_color(card.color.as_deref().unwrap_or(""))?;
    check_review_gate(conn, board, &column, actor)?;
    let tx = conn.unchecked_transaction().map_err(db)?;
    ensure_board(&tx, board)?;
    let number: i64 =
        tx.query_row("SELECT next_number FROM board_boards WHERE board_key=?1", [board], |r| r.get(0)).map_err(db)?;
    tx.execute("UPDATE board_boards SET next_number=next_number+1 WHERE board_key=?1", [board]).map_err(db)?;
    let id = uuid::Uuid::new_v4().to_string();
    let position = end_position(&tx, board, &column, &id)?;
    let at = now();
    tx.execute(
        "INSERT INTO board_cards(id,board_key,number,column_id,position,type,title,description,priority,color,created_at,updated_at,updated_kind,updated_session)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?13,?10,?10,?11,?12)",
        params![id, board, number, column, position, card_type, title, description, priority, at, actor.kind(), actor.session(), color],
    )
    .map_err(db)?;
    set_tags(&tx, &id, &tags)?;
    touch(&tx, &id, actor, "created", "")?;
    tx.commit().map_err(db)?;
    card_json(conn, board, number)
}

pub fn update_card(conn: &Connection, board: &str, number: i64, patch: CardPatch, actor: &Actor) -> Result<Value> {
    let id = card_id(conn, board, number)?;
    let mut changed: Vec<&str> = Vec::new();
    let tx = conn.unchecked_transaction().map_err(db)?;
    if let Some(title) = &patch.title {
        tx.execute("UPDATE board_cards SET title=?2 WHERE id=?1", params![id, clean_title(title)?]).map_err(db)?;
        changed.push("title");
    }
    if let Some(card_type) = &patch.card_type {
        tx.execute("UPDATE board_cards SET type=?2 WHERE id=?1", params![id, one_of(card_type, &TYPES, "type")?]).map_err(db)?;
        changed.push("type");
    }
    if let Some(description) = &patch.description {
        tx.execute("UPDATE board_cards SET description=?2 WHERE id=?1", params![id, clean_description(description)?]).map_err(db)?;
        changed.push("description");
    }
    if let Some(priority) = &patch.priority {
        tx.execute("UPDATE board_cards SET priority=?2 WHERE id=?1", params![id, one_of(priority, &PRIORITIES, "priority")?])
            .map_err(db)?;
        changed.push("priority");
    }
    if let Some(tags) = &patch.tags {
        set_tags(&tx, &id, &clean_tags(tags)?)?;
        changed.push("tags");
    }
    if let Some(color) = &patch.color {
        tx.execute("UPDATE board_cards SET color=?2 WHERE id=?1", params![id, clean_color(color)?]).map_err(db)?;
        changed.push("colour");
    }
    if !changed.is_empty() {
        let action = if changed == ["tags"] { "tagged" } else { "edited" };
        touch(&tx, &id, actor, action, &changed.join(", "))?;
    }
    tx.commit().map_err(db)?;
    card_json(conn, board, number)
}

/// Move a card to `column`, before card `before` when given, otherwise to the end of the column.
/// Cards moved back to Backlog or To Do lose their claim.
pub fn move_card(conn: &Connection, board: &str, number: i64, column: &str, before: Option<i64>, actor: &Actor) -> Result<Value> {
    check_column(conn, board, column)?;
    let id = card_id(conn, board, number)?;
    check_review_gate(conn, board, column, actor)?;
    let role = column_role(conn, board, column)?;
    let tx = conn.unchecked_transaction().map_err(db)?;
    place(&tx, board, &id, column, before)?;
    if matches!(role.as_deref(), Some("backlog" | "todo")) {
        tx.execute("UPDATE board_cards SET claimed_by=NULL WHERE id=?1", [&id]).map_err(db)?;
    }
    touch(&tx, &id, actor, "moved", column)?;
    tx.commit().map_err(db)?;
    card_json(conn, board, number)
}

fn place(conn: &Connection, board: &str, id: &str, column: &str, before: Option<i64>) -> Result<()> {
    let position = match before {
        Some(target) => {
            let (target_id, target_column, target_pos): (String, String, f64) = conn
                .query_row(
                    "SELECT id, column_id, position FROM board_cards WHERE board_key=?1 AND number=?2",
                    params![board, target],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()
                .map_err(db)?
                .ok_or_else(|| format!("Card #{target} not found."))?;
            if target_column != column || target_id == id {
                end_position(conn, board, column, id)?
            } else {
                let above: Option<f64> = conn
                    .query_row(
                        "SELECT MAX(position) FROM board_cards WHERE board_key=?1 AND column_id=?2 AND position<?3 AND id<>?4",
                        params![board, column, target_pos, id],
                        |r| r.get(0),
                    )
                    .map_err(db)?;
                (above.unwrap_or(target_pos - 1.0) + target_pos) / 2.0
            }
        }
        None => end_position(conn, board, column, id)?,
    };
    conn.execute("UPDATE board_cards SET column_id=?2, position=?3 WHERE id=?1", params![id, column, position]).map_err(db)?;
    Ok(())
}

pub fn delete_card(conn: &Connection, board: &str, number: i64, _actor: &Actor) -> Result<()> {
    let id = card_id(conn, board, number)?;
    conn.execute("DELETE FROM board_cards WHERE id=?1", [&id]).map_err(db)?;
    Ok(())
}

/// One card with its history (newest first).
pub fn card_detail(conn: &Connection, board: &str, number: i64) -> Result<Value> {
    let mut card = card_json(conn, board, number)?;
    let id = card["id"].as_str().unwrap_or_default().to_string();
    let mut stmt = conn
        .prepare(
            "SELECT h.id, h.actor_kind, s.name, h.action, h.detail, h.created_at FROM board_history h
             LEFT JOIN sessions s ON s.id=h.actor_session WHERE h.card_id=?1 ORDER BY h.rowid DESC",
        )
        .map_err(db)?;
    let history: Vec<Value> = stmt
        .query_map([&id], |r| {
            Ok(json!({
                "id": r.get::<_, String>(0)?, "actorKind": r.get::<_, String>(1)?,
                "actorName": r.get::<_, Option<String>>(2)?, "action": r.get::<_, String>(3)?,
                "detail": r.get::<_, String>(4)?, "createdAt": r.get::<_, i64>(5)?,
            }))
        })
        .map_err(db)?
        .collect::<std::result::Result<_, _>>()
        .map_err(db)?;
    card["history"] = json!(history);
    Ok(card)
}

/// Give a specific card to a session: In Progress, taken by it.
pub fn claim(conn: &Connection, board: &str, number: i64, session: &str) -> Result<Value> {
    let id = card_id(conn, board, number)?;
    let tx = conn.unchecked_transaction().map_err(db)?;
    take(&tx, board, &id, session)?;
    tx.commit().map_err(db)?;
    card_json(conn, board, number)
}

fn take(conn: &Connection, board: &str, id: &str, session: &str) -> Result<()> {
    let working = role_column(conn, board, "in_progress")?.ok_or("This board has no In Progress column.")?;
    place(conn, board, id, &working, None)?;
    conn.execute("UPDATE board_cards SET claimed_by=?2 WHERE id=?1", params![id, session]).map_err(db)?;
    touch(conn, id, &Actor::Agent(session.to_string()), "claimed", "")
}

/// Take the top To Do card (priority, then position) for `session`. The write lock is held from the read
/// to the update, so two sessions can never receive the same card.
pub fn claim_next(conn: &Connection, board: &str, session: &str) -> Result<Option<Value>> {
    let todo = role_column(conn, board, "todo")?.ok_or("This board has no To Do column.")?;
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate).map_err(db)?;
    let next: Option<(String, i64)> = tx
        .query_row(
            "SELECT id, number FROM board_cards WHERE board_key=?1 AND column_id=?2
             ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, position
             LIMIT 1",
            params![board, todo],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(db)?;
    let Some((id, number)) = next else {
        tx.commit().map_err(db)?;
        return Ok(None);
    };
    take(&tx, board, &id, session)?;
    tx.commit().map_err(db)?;
    card_json(conn, board, number).map(Some)
}

/// Finish a card from an agent: the Review column when there is one, otherwise Done.
pub fn finish(conn: &Connection, board: &str, number: i64, session: &str) -> Result<Value> {
    let id = card_id(conn, board, number)?;
    let column = match role_column(conn, board, "review")? {
        Some(review) => review,
        None => role_column(conn, board, "done")?.ok_or("This board has no Review or Done column.")?,
    };
    let actor = Actor::Agent(session.to_string());
    let tx = conn.unchecked_transaction().map_err(db)?;
    place(&tx, board, &id, &column, None)?;
    touch(&tx, &id, &actor, "moved", &column)?;
    tx.commit().map_err(db)?;
    card_json(conn, board, number)
}

pub fn list(conn: &Connection, board: &str, filter: ListFilter) -> Result<Vec<Value>> {
    let column = filter.column.as_deref().map(|c| resolve_column(conn, board, c)).transpose()?;
    if let Some(card_type) = &filter.type_ {
        one_of(card_type, &TYPES, "type")?;
    }
    let tag = filter.tag.map(|t| t.trim().to_lowercase());
    let search = filter.search.map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty());
    Ok(all_cards(conn, board)?
        .into_iter()
        .filter(|c| column.as_ref().is_none_or(|col| c["column"] == *col))
        .filter(|c| filter.type_.as_ref().is_none_or(|t| c["type"] == *t))
        .filter(|c| tag.as_ref().is_none_or(|t| c["tags"].as_array().is_some_and(|tags| tags.iter().any(|x| x == t))))
        .filter(|c| {
            search.as_ref().is_none_or(|q| {
                let text = |key: &str| c[key].as_str().unwrap_or_default().to_lowercase();
                text("title").contains(q)
                    || text("description").contains(q)
                    || c["tags"].as_array().is_some_and(|tags| tags.iter().any(|t| t.as_str().is_some_and(|t| t.contains(q))))
            })
        })
        .collect())
}
