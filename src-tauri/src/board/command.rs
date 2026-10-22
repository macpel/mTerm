//! `vboard` arguments and their effect on the board. Pure parsing plus one `execute` over a connection, so
//! both run in tests without the app.

use super::store::{self, Actor, CardPatch, ListFilter, NewCard, Result};
use rusqlite::Connection;
use serde_json::{json, Value};

pub const USAGE: &str = "usage: vboard <command>
  list [--column C] [--type T] [--tag T] [--search TEXT]   list cards
  show N                                                    one card with notes and history
  add \"title\" [--type T] [--desc TEXT] [--priority P] [--tag a,b] [--column C]
  edit N [--title TEXT] [--type T] [--desc TEXT] [--priority P]
  tag N +add -remove                                        change tags
  move N <column>                                           move a card
  note N \"text\"                                             add a note
  next                                                      take the top To Do card
  done N \"summary\"                                          finish: Review when on, else Done
  delete N                                                  delete a card (prefer done)
Columns: backlog, todo, in_progress, review, done. Types: task, bug, feature, epic.
Priorities: low, medium, high, urgent. N may be written 12 or #12.";

#[derive(Debug)]
pub enum BoardCommand {
    Help,
    List(ListFilter),
    Show(i64),
    Add { title: String, card_type: Option<String>, description: Option<String>, priority: Option<String>, tags: Vec<String>, column: Option<String> },
    Edit { number: i64, title: Option<String>, card_type: Option<String>, description: Option<String>, priority: Option<String> },
    Tag { number: i64, add: Vec<String>, remove: Vec<String> },
    Move { number: i64, column: String },
    Note { number: i64, text: String },
    Next,
    Done { number: i64, summary: String },
    Delete(i64),
}

fn card_number(word: Option<&String>) -> Result<i64> {
    let word = word.ok_or("Give a card number, for example 12.")?;
    word.trim_start_matches('#').parse().map_err(|_| format!("\"{word}\" is not a card number."))
}

fn column(word: &str) -> Result<String> {
    let normal = word.trim().to_lowercase().replace('-', "_");
    if store::COLUMNS.contains(&normal.as_str()) {
        Ok(normal)
    } else {
        Err(format!("Unknown column \"{word}\". Use one of: {}.", store::COLUMNS.join(", ")))
    }
}

/// Positional words and `--flag value` pairs; only the flags in `allowed` are accepted.
fn split(words: &[String], allowed: &[&str]) -> Result<(Vec<String>, Vec<(String, String)>)> {
    let mut positional = Vec::new();
    let mut flags = Vec::new();
    let mut i = 0;
    while i < words.len() {
        let word = &words[i];
        if let Some(name) = word.strip_prefix("--") {
            if !allowed.contains(&name) {
                return Err(format!("Unknown option --{name}. Run vboard help."));
            }
            let value = words.get(i + 1).ok_or_else(|| format!("--{name} needs a value."))?;
            flags.push((name.to_string(), value.clone()));
            i += 2;
        } else {
            positional.push(word.clone());
            i += 1;
        }
    }
    Ok((positional, flags))
}

fn flag(flags: &[(String, String)], name: &str) -> Option<String> {
    flags.iter().rev().find(|(n, _)| n == name).map(|(_, v)| v.clone())
}

fn rest(words: &[String]) -> String {
    words.join(" ").trim().to_string()
}

pub fn parse(args: &[String]) -> Result<BoardCommand> {
    let Some((name, words)) = args.split_first() else { return Ok(BoardCommand::Help) };
    Ok(match name.as_str() {
        "help" | "--help" | "-h" => BoardCommand::Help,
        "list" | "ls" => {
            let (_, flags) = split(words, &["column", "type", "tag", "search"])?;
            BoardCommand::List(ListFilter {
                column: flag(&flags, "column").map(|c| column(&c)).transpose()?,
                type_: flag(&flags, "type"),
                tag: flag(&flags, "tag"),
                search: flag(&flags, "search"),
            })
        }
        "show" => BoardCommand::Show(card_number(words.first())?),
        "add" => {
            let (positional, flags) = split(words, &["type", "desc", "priority", "tag", "column"])?;
            BoardCommand::Add {
                title: rest(&positional),
                card_type: flag(&flags, "type"),
                description: flag(&flags, "desc"),
                priority: flag(&flags, "priority"),
                tags: flag(&flags, "tag").map(|t| t.split(',').map(|s| s.trim().to_string()).collect()).unwrap_or_default(),
                column: flag(&flags, "column").map(|c| column(&c)).transpose()?,
            }
        }
        "edit" => {
            let (positional, flags) = split(words, &["title", "type", "desc", "priority"])?;
            BoardCommand::Edit {
                number: card_number(positional.first())?,
                title: flag(&flags, "title"),
                card_type: flag(&flags, "type"),
                description: flag(&flags, "desc"),
                priority: flag(&flags, "priority"),
            }
        }
        "tag" => {
            let number = card_number(words.first())?;
            let (mut add, mut remove) = (Vec::new(), Vec::new());
            for word in &words[1..] {
                if let Some(tag) = word.strip_prefix('-') {
                    remove.push(tag.to_string());
                } else {
                    add.push(word.strip_prefix('+').unwrap_or(word).to_string());
                }
            }
            BoardCommand::Tag { number, add, remove }
        }
        "move" | "mv" => BoardCommand::Move {
            number: card_number(words.first())?,
            column: column(words.get(1).ok_or("Give a column, for example: vboard move 12 in_progress")?)?,
        },
        "note" => BoardCommand::Note { number: card_number(words.first())?, text: rest(&words[1.min(words.len())..]) },
        "next" => BoardCommand::Next,
        "done" => BoardCommand::Done { number: card_number(words.first())?, summary: rest(&words[1.min(words.len())..]) },
        "delete" | "rm" => BoardCommand::Delete(card_number(words.first())?),
        other => return Err(format!("Unknown command \"{other}\". Run vboard help.")),
    })
}

/// Run a parsed command as `session`. Returns the result and whether the board changed.
pub fn execute(conn: &Connection, project: &str, session: &str, cmd: BoardCommand) -> Result<(Value, bool)> {
    let actor = Actor::Agent(session.to_string());
    Ok(match cmd {
        BoardCommand::Help => (json!(USAGE), false),
        BoardCommand::List(filter) => (json!(store::list(conn, project, filter)?), false),
        BoardCommand::Show(n) => (store::card_detail(conn, project, n)?, false),
        BoardCommand::Add { title, card_type, description, priority, tags, column } => {
            let card = NewCard {
                title,
                card_type: card_type.unwrap_or_default(),
                description: description.unwrap_or_default(),
                priority: priority.unwrap_or_default(),
                tags,
                column,
            };
            (store::create_card(conn, project, card, &actor)?, true)
        }
        BoardCommand::Edit { number, title, card_type, description, priority } => {
            let patch = CardPatch { title, card_type, description, priority, tags: None };
            (store::update_card(conn, project, number, patch, &actor)?, true)
        }
        BoardCommand::Tag { number, add, remove } => {
            let card = store::card_detail(conn, project, number)?;
            let remove: Vec<String> = remove.iter().map(|t| t.trim().to_lowercase()).collect();
            let mut tags: Vec<String> = card["tags"]
                .as_array()
                .map(|tags| tags.iter().filter_map(|t| t.as_str().map(str::to_string)).collect())
                .unwrap_or_default();
            tags.retain(|t| !remove.contains(t));
            tags.extend(add);
            let patch = CardPatch { tags: Some(tags), ..Default::default() };
            (store::update_card(conn, project, number, patch, &actor)?, true)
        }
        BoardCommand::Move { number, column } => (store::move_card(conn, project, number, &column, None, &actor)?, true),
        BoardCommand::Note { number, text } => (store::add_note(conn, project, number, &text, &actor)?, true),
        BoardCommand::Next => match store::claim_next(conn, project, session)? {
            Some(card) => (json!({ "card": card }), true),
            None => (json!({ "card": null, "message": "To Do is empty." }), false),
        },
        BoardCommand::Done { number, summary } => (store::finish(conn, project, number, session, &summary)?, true),
        BoardCommand::Delete(number) => {
            store::delete_card(conn, project, number, &actor)?;
            (json!({ "deleted": number }), true)
        }
    })
}
