use super::store::{self, Actor, CardPatch, ListFilter, NewCard};
use rusqlite::Connection;
use serde_json::Value;

const PROJECT: &str = "p1";
const S1: &str = "s1";
const S2: &str = "s2";

fn setup(conn: &Connection) {
    conn.execute_batch(crate::db::schema::SCHEMA).unwrap();
    super::init(conn).unwrap();
    conn.execute_batch(
        "INSERT INTO projects(id,name,root_path,created_at) VALUES('p1','Demo','C:/demo',0);
         INSERT INTO sessions(id,project_id,name,kind,created_at) VALUES('s1','p1','Session One','claude',0);
         INSERT INTO sessions(id,project_id,name,kind,created_at) VALUES('s2','p1','Session Two','claude',0);",
    )
    .unwrap();
}

fn db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    setup(&conn);
    conn
}

fn add(conn: &Connection, title: &str, priority: &str) -> i64 {
    let card = store::create_card(
        conn,
        PROJECT,
        NewCard { title: title.into(), card_type: "task".into(), priority: priority.into(), ..Default::default() },
        &Actor::User,
    )
    .unwrap();
    card["number"].as_i64().unwrap()
}

fn column_order(conn: &Connection, column: &str) -> Vec<i64> {
    let board = store::get_board(conn, PROJECT).unwrap();
    let mut cards: Vec<&Value> = board["cards"].as_array().unwrap().iter().filter(|c| c["column"] == column).collect();
    cards.sort_by(|a, b| a["position"].as_f64().unwrap().partial_cmp(&b["position"].as_f64().unwrap()).unwrap());
    cards.iter().map(|c| c["number"].as_i64().unwrap()).collect()
}

#[test]
fn board_is_created_on_first_use() {
    let conn = db();
    let board = store::get_board(&conn, PROJECT).unwrap();
    assert_eq!(board["reviewEnabled"], false);
    assert_eq!(board["cards"], serde_json::json!([]));
}

#[test]
fn numbers_increase_and_are_never_reused() {
    let conn = db();
    assert_eq!(add(&conn, "one", "medium"), 1);
    assert_eq!(add(&conn, "two", "medium"), 2);
    store::delete_card(&conn, PROJECT, 2, &Actor::User).unwrap();
    assert_eq!(add(&conn, "three", "medium"), 3);
}

#[test]
fn tags_are_trimmed_lowercased_and_deduplicated() {
    let conn = db();
    let card = store::create_card(
        &conn,
        PROJECT,
        NewCard {
            title: "t".into(),
            card_type: "bug".into(),
            tags: vec!["UI ".into(), "ui".into(), "Ui".into(), "bug".into()],
            ..Default::default()
        },
        &Actor::User,
    )
    .unwrap();
    assert_eq!(card["tags"], serde_json::json!(["bug", "ui"]));
}

#[test]
fn move_places_card_before_target() {
    let conn = db();
    add(&conn, "a", "medium");
    add(&conn, "b", "medium");
    add(&conn, "c", "medium");
    store::move_card(&conn, PROJECT, 3, "todo", Some(1), &Actor::User).unwrap();
    assert_eq!(column_order(&conn, "todo"), vec![3, 1, 2]);
}

#[test]
fn agent_cannot_move_to_done_while_review_on() {
    let conn = db();
    add(&conn, "a", "medium");
    store::set_review(&conn, PROJECT, true).unwrap();
    let err = store::move_card(&conn, PROJECT, 1, "done", None, &Actor::Agent(S1.into())).unwrap_err();
    assert_eq!(err, "Review is on: use vboard done; a person moves cards to Done.");
    store::move_card(&conn, PROJECT, 1, "done", None, &Actor::User).unwrap();
    assert_eq!(column_order(&conn, "done"), vec![1]);
}

#[test]
fn claim_next_takes_highest_priority_then_position() {
    let conn = db();
    add(&conn, "one", "medium");
    add(&conn, "two", "urgent");
    add(&conn, "three", "urgent");
    let first = store::claim_next(&conn, PROJECT, S1).unwrap().unwrap();
    assert_eq!(first["number"], 2);
    assert_eq!(first["column"], "in_progress");
    assert_eq!(first["claimedBy"], S1);
    assert_eq!(store::claim_next(&conn, PROJECT, S1).unwrap().unwrap()["number"], 3);
    assert_eq!(store::claim_next(&conn, PROJECT, S1).unwrap().unwrap()["number"], 1);
    assert!(store::claim_next(&conn, PROJECT, S1).unwrap().is_none());
}

#[test]
fn claim_next_never_hands_out_a_card_twice() {
    let path = std::env::temp_dir().join(format!("board-claim-{}.db", uuid::Uuid::new_v4()));
    {
        let conn = Connection::open(&path).unwrap();
        setup(&conn);
        for i in 0..40 {
            add(&conn, &format!("card {i}"), "medium");
        }
    }
    // Four sessions race until To Do is empty. Every claim must succeed (no "database is busy") and every
    // card must go to exactly one session.
    let start = std::sync::Arc::new(std::sync::Barrier::new(4));
    let workers: Vec<_> = [S1, S2, S1, S2]
        .into_iter()
        .map(|session| {
            let path = path.clone();
            let start = start.clone();
            std::thread::spawn(move || {
                let conn = Connection::open(&path).unwrap();
                conn.busy_timeout(std::time::Duration::from_secs(5)).unwrap();
                start.wait();
                let mut taken = Vec::new();
                while let Some(card) = store::claim_next(&conn, PROJECT, session).expect("claim must not fail") {
                    taken.push(card["number"].as_i64().unwrap());
                }
                taken
            })
        })
        .collect();
    let mut all: Vec<i64> = workers.into_iter().flat_map(|w| w.join().unwrap()).collect();
    all.sort();
    assert_eq!(all, (1..=40).collect::<Vec<i64>>());
    let _ = std::fs::remove_file(&path);
}

#[test]
fn finish_goes_to_review_or_done() {
    let conn = db();
    add(&conn, "a", "medium");
    add(&conn, "b", "medium");
    store::set_review(&conn, PROJECT, true).unwrap();
    assert_eq!(store::finish(&conn, PROJECT, 1, S1, "fixed it").unwrap()["column"], "review");
    store::set_review(&conn, PROJECT, false).unwrap();
    assert_eq!(store::finish(&conn, PROJECT, 2, S1, "done too").unwrap()["column"], "done");
    let detail = store::card_detail(&conn, PROJECT, 1).unwrap();
    assert_eq!(detail["notes"][0]["text"], "fixed it");
    assert_eq!(detail["notes"][0]["authorKind"], "agent");
    assert_eq!(detail["notes"][0]["authorName"], "Session One");
}

#[test]
fn list_filters_by_column_type_tag_and_search() {
    let conn = db();
    store::create_card(
        &conn,
        PROJECT,
        NewCard { title: "Login crash".into(), card_type: "bug".into(), tags: vec!["auth".into()], ..Default::default() },
        &Actor::User,
    )
    .unwrap();
    store::create_card(
        &conn,
        PROJECT,
        NewCard {
            title: "Dark mode".into(),
            card_type: "feature".into(),
            description: "Add a THEME switch".into(),
            column: Some("backlog".into()),
            ..Default::default()
        },
        &Actor::User,
    )
    .unwrap();
    let numbers = |filter: ListFilter| -> Vec<i64> {
        store::list(&conn, PROJECT, filter).unwrap().iter().map(|c| c["number"].as_i64().unwrap()).collect()
    };
    assert_eq!(numbers(ListFilter { column: Some("backlog".into()), ..Default::default() }), vec![2]);
    assert_eq!(numbers(ListFilter { type_: Some("bug".into()), ..Default::default() }), vec![1]);
    assert_eq!(numbers(ListFilter { tag: Some("AUTH".into()), ..Default::default() }), vec![1]);
    assert_eq!(numbers(ListFilter { search: Some("theme".into()), ..Default::default() }), vec![2]);
    assert_eq!(numbers(ListFilter { search: Some("auth".into()), ..Default::default() }), vec![1]);
}

#[test]
fn history_records_actor() {
    let conn = db();
    add(&conn, "a", "medium");
    store::move_card(&conn, PROJECT, 1, "in_progress", None, &Actor::Agent(S2.into())).unwrap();
    let detail = store::card_detail(&conn, PROJECT, 1).unwrap();
    let latest = &detail["history"][0];
    assert_eq!(latest["action"], "moved");
    assert_eq!(latest["actorKind"], "agent");
    assert_eq!(latest["actorName"], "Session Two");
    assert_eq!(detail["updatedBy"]["kind"], "agent");
    assert_eq!(detail["updatedBy"]["sessionId"], S2);
}

#[test]
fn edit_and_rejects_invalid_values() {
    let conn = db();
    add(&conn, "a", "medium");
    let card = store::update_card(
        &conn,
        PROJECT,
        1,
        CardPatch { title: Some("  renamed ".into()), priority: Some("high".into()), ..Default::default() },
        &Actor::User,
    )
    .unwrap();
    assert_eq!(card["title"], "renamed");
    assert_eq!(card["priority"], "high");
    let bad = CardPatch { priority: Some("whenever".into()), ..Default::default() };
    assert!(store::update_card(&conn, PROJECT, 1, bad, &Actor::User).is_err());
    assert_eq!(store::move_card(&conn, PROJECT, 9, "todo", None, &Actor::User).unwrap_err(), "Card #9 not found.");
}

// ── vboard command parsing and execution ──

use super::command::{self, BoardCommand};

fn args(words: &[&str]) -> Vec<String> {
    words.iter().map(|w| w.to_string()).collect()
}

#[test]
fn parse_accepts_hash_numbers() {
    assert!(matches!(command::parse(&args(&["show", "#12"])).unwrap(), BoardCommand::Show(12)));
    assert!(matches!(command::parse(&args(&["show", "12"])).unwrap(), BoardCommand::Show(12)));
}

#[test]
fn parse_rejects_unknown_column() {
    let err = command::parse(&args(&["move", "3", "doing"])).unwrap_err();
    assert_eq!(err, "Unknown column \"doing\". Use one of: backlog, todo, in_progress, review, done.");
}

#[test]
fn parse_tag_changes() {
    match command::parse(&args(&["tag", "4", "+ui", "-bug"])).unwrap() {
        BoardCommand::Tag { number, add, remove } => {
            assert_eq!(number, 4);
            assert_eq!(add, vec!["ui".to_string()]);
            assert_eq!(remove, vec!["bug".to_string()]);
        }
        _ => panic!("expected Tag"),
    }
}

#[test]
fn parse_add_with_options() {
    match command::parse(&args(&["add", "Fix", "login", "--type", "bug", "--priority", "high", "--tag", "auth,ui"])).unwrap() {
        BoardCommand::Add { title, card_type, priority, tags, .. } => {
            assert_eq!(title, "Fix login");
            assert_eq!(card_type.as_deref(), Some("bug"));
            assert_eq!(priority.as_deref(), Some("high"));
            assert_eq!(tags, vec!["auth".to_string(), "ui".to_string()]);
        }
        _ => panic!("expected Add"),
    }
}

#[test]
fn execute_next_reports_empty_board() {
    let conn = db();
    let (value, changed) = command::execute(&conn, PROJECT, S1, BoardCommand::Next).unwrap();
    assert_eq!(value, serde_json::json!({ "card": null, "message": "To Do is empty." }));
    assert!(!changed);
}

#[test]
fn execute_tag_merges_with_existing_tags() {
    let conn = db();
    store::create_card(
        &conn,
        PROJECT,
        NewCard { title: "a".into(), tags: vec!["bug".into(), "old".into()], ..Default::default() },
        &Actor::User,
    )
    .unwrap();
    let cmd = command::parse(&args(&["tag", "1", "+ui", "-old"])).unwrap();
    let (card, changed) = command::execute(&conn, PROJECT, S1, cmd).unwrap();
    assert_eq!(card["tags"], serde_json::json!(["bug", "ui"]));
    assert_eq!(card["updatedBy"]["kind"], "agent");
    assert!(changed);
}

#[test]
fn agent_cannot_add_straight_to_done_while_review_on() {
    let conn = db();
    store::set_review(&conn, PROJECT, true).unwrap();
    let card = |column: &str| NewCard { title: "Fixed it".into(), column: Some(column.into()), ..Default::default() };
    let err = store::create_card(&conn, PROJECT, card("done"), &Actor::Agent(S1.into())).unwrap_err();
    assert_eq!(err, "Review is on: use vboard done; a person moves cards to Done.");
    assert_eq!(store::create_card(&conn, PROJECT, card("done"), &Actor::User).unwrap()["column"], "done");
    store::set_review(&conn, PROJECT, false).unwrap();
    assert_eq!(store::create_card(&conn, PROJECT, card("done"), &Actor::Agent(S1.into())).unwrap()["column"], "done");
}
