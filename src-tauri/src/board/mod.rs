//! Per-project Kanban board shared by people and agent sessions. `store` owns the tables and every rule;
//! `dispatch` serves the app's `board_*` commands and announces each write with `board://changed`.

pub mod store;
pub mod command;
pub mod agent;
#[cfg(test)]
mod tests;

use crate::host::AppCtx;
use rusqlite::Connection;
use serde_json::{json, Value};
use store::{Actor, CardPatch, NewCard, Result};

pub const CHANGED_EVENT: &str = "board://changed";

pub fn init(conn: &Connection) -> Result<()> {
    conn.execute_batch(store::SCHEMA).map_err(|e| e.to_string())
}

fn text<'a>(args: &'a Value, key: &str) -> Result<&'a str> {
    args.get(key).and_then(Value::as_str).ok_or_else(|| format!("Missing {key}."))
}

fn number(args: &Value, key: &str) -> Result<i64> {
    args.get(key).and_then(Value::as_i64).ok_or_else(|| format!("Missing {key}."))
}

fn opt_text(args: &Value, key: &str) -> Option<String> {
    args.get(key).and_then(Value::as_str).map(str::to_string)
}

fn tags(args: &Value) -> Option<Vec<String>> {
    args.get("tags").and_then(Value::as_array).map(|items| items.iter().filter_map(|t| t.as_str().map(str::to_string)).collect())
}

/// Tell every client that the project's board changed.
pub fn announce(app: &AppCtx, project: &str) {
    app.emit(CHANGED_EVENT, json!({ "projectId": project }));
}

pub fn dispatch(app: &AppCtx, cmd: &str, args: &Value) -> Result<Value> {
    let project = text(args, "projectId")?.to_string();
    let result = {
        let conn = app.db().conn.lock().map_err(|e| e.to_string())?;
        let conn = &*conn;
        match cmd {
            "board_get" => return store::get_board(conn, &project),
            "board_card_detail" => return store::card_detail(conn, &project, number(args, "number")?),
            "board_card_create" => store::create_card(
                conn,
                &project,
                NewCard {
                    title: text(args, "title")?.to_string(),
                    card_type: opt_text(args, "type").unwrap_or_default(),
                    description: opt_text(args, "description").unwrap_or_default(),
                    priority: opt_text(args, "priority").unwrap_or_default(),
                    tags: tags(args).unwrap_or_default(),
                    column: opt_text(args, "column"),
                },
                &Actor::User,
            )?,
            "board_card_update" => store::update_card(
                conn,
                &project,
                number(args, "number")?,
                CardPatch {
                    title: opt_text(args, "title"),
                    card_type: opt_text(args, "type"),
                    description: opt_text(args, "description"),
                    priority: opt_text(args, "priority"),
                    tags: tags(args),
                },
                &Actor::User,
            )?,
            "board_card_move" => store::move_card(
                conn,
                &project,
                number(args, "number")?,
                text(args, "column")?,
                args.get("beforeNumber").and_then(Value::as_i64),
                &Actor::User,
            )?,
            "board_card_delete" => {
                store::delete_card(conn, &project, number(args, "number")?, &Actor::User)?;
                Value::Null
            }
            "board_note_add" => store::add_note(conn, &project, number(args, "number")?, text(args, "text")?, &Actor::User)?,
            "board_set_review" => {
                store::set_review(conn, &project, args.get("enabled").and_then(Value::as_bool).unwrap_or(false))?;
                Value::Null
            }
            "board_claim" => store::claim(conn, &project, number(args, "number")?, text(args, "sessionId")?)?,
            _ => return Err(format!("Unknown board command {cmd}.")),
        }
    };
    announce(app, &project);
    Ok(result)
}
