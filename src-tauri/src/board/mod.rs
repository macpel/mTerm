//! Per-project Kanban board shared by people and agent sessions. `store` owns the tables and every rule;
//! `dispatch` serves the app's `board_*` commands and announces each write with `board://changed`.

pub mod store;
pub mod command;
pub mod agent;
pub mod images;
#[cfg(test)]
mod tests;

use crate::host::AppCtx;
use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};
use store::{Actor, CardPatch, NewCard, Result};

pub const CHANGED_EVENT: &str = "board://changed";

pub fn init(conn: &Connection) -> Result<()> {
    store::init(conn)
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

/// The board key of a project: its folder (see `store::folder_key`). Collections have no folder and no board.
pub fn board_key(conn: &Connection, project_id: &str) -> Result<String> {
    let root: Option<String> = conn
        .query_row("SELECT root_path FROM projects WHERE id=?1", [project_id], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    match root {
        None => Err("Project not found.".into()),
        Some(root) if root.trim().is_empty() => Err("Collections have no board.".into()),
        Some(root) => Ok(store::folder_key(&root)),
    }
}

/// Tell every client that the project's board changed, and drop pasted images no card links to any more.
pub fn announce(app: &AppCtx, project: &str) {
    app.emit(CHANGED_EVENT, json!({ "projectId": project }));
    if let (Ok(data_dir), Ok(conn)) = (app.data_dir(), app.db().conn.lock()) {
        let _ = images::sweep(&conn, &images::dir(&data_dir));
    }
}

pub fn dispatch(app: &AppCtx, cmd: &str, args: &Value) -> Result<Value> {
    let project = text(args, "projectId")?.to_string();
    let result = {
        let conn = app.db().conn.lock().map_err(|e| e.to_string())?;
        let conn = &*conn;
        let key = board_key(conn, &project)?;
        match cmd {
            "board_get" => return store::get_board(conn, &key),
            "board_card_detail" => return store::card_detail(conn, &key, number(args, "number")?),
            "board_card_create" => store::create_card(
                conn,
                &key,
                NewCard {
                    title: text(args, "title")?.to_string(),
                    card_type: opt_text(args, "type").unwrap_or_default(),
                    description: opt_text(args, "description").unwrap_or_default(),
                    priority: opt_text(args, "priority").unwrap_or_default(),
                    tags: tags(args).unwrap_or_default(),
                    column: opt_text(args, "column"),
                    color: opt_text(args, "color"),
                },
                &Actor::User,
            )?,
            "board_card_update" => store::update_card(
                conn,
                &key,
                number(args, "number")?,
                CardPatch {
                    title: opt_text(args, "title"),
                    card_type: opt_text(args, "type"),
                    description: opt_text(args, "description"),
                    priority: opt_text(args, "priority"),
                    tags: tags(args),
                    color: opt_text(args, "color"),
                },
                &Actor::User,
            )?,
            "board_card_move" => store::move_card(
                conn,
                &key,
                number(args, "number")?,
                text(args, "column")?,
                args.get("beforeNumber").and_then(Value::as_i64),
                &Actor::User,
            )?,
            "board_card_delete" => {
                store::delete_card(conn, &key, number(args, "number")?, &Actor::User)?;
                Value::Null
            }
            "board_column_add" => {
                store::add_column(conn, &key, opt_text(args, "name").as_deref(), opt_text(args, "role").as_deref())?
            }
            "board_column_rename" => {
                store::rename_column(conn, &key, text(args, "columnId")?, text(args, "name")?)?;
                Value::Null
            }
            "board_column_move" => {
                store::move_column(conn, &key, text(args, "columnId")?, opt_text(args, "beforeColumnId").as_deref())?;
                Value::Null
            }
            "board_column_delete" => {
                store::delete_column(conn, &key, text(args, "columnId")?, &Actor::User)?;
                Value::Null
            }
            "board_claim" => store::claim(conn, &key, number(args, "number")?, text(args, "sessionId")?)?,
            _ => return Err(format!("Unknown board command {cmd}.")),
        }
    };
    announce(app, &project);
    Ok(result)
}
