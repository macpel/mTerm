use super::store::{self, Actor, CardPatch, ListFilter, NewCard};
use rusqlite::Connection;
use serde_json::Value;

const PROJECT: &str = "p1";
const S1: &str = "s1";
const S2: &str = "s2";

fn setup(conn: &Connection) {
    // Like the app's connection (db/mod.rs), so cascades behave as they do for users.
    conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
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

/// Switch Review on or off by adding or deleting the Review column.
fn review(conn: &Connection, on: bool) {
    if on {
        store::add_column(conn, PROJECT, None, Some("review")).unwrap();
    } else {
        store::delete_column(conn, PROJECT, "review", &Actor::User).unwrap();
    }
}

fn column_ids(conn: &Connection) -> Vec<String> {
    store::columns(conn, PROJECT).unwrap().iter().map(|c| c["id"].as_str().unwrap().to_string()).collect()
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
    let roles: Vec<&str> = board["columns"].as_array().unwrap().iter().map(|c| c["role"].as_str().unwrap()).collect();
    assert_eq!(roles, vec!["backlog", "todo", "in_progress", "done"]);
    assert_eq!(board["columns"][0]["name"], serde_json::Value::Null);
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
    review(&conn, true);
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
    review(&conn, true);
    assert_eq!(store::finish(&conn, PROJECT, 1, S1).unwrap()["column"], "review");
    let detail = store::card_detail(&conn, PROJECT, 1).unwrap();
    assert!(detail.get("notes").is_none());
    assert_eq!(detail["history"][0]["action"], "moved");
    assert_eq!(detail["history"][0]["actorName"], "Session One");
    review(&conn, false);
    assert_eq!(store::finish(&conn, PROJECT, 2, S1).unwrap()["column"], "done");
}

#[test]
fn notes_are_gone_and_done_ignores_extra_words() {
    let conn = db();
    add(&conn, "a", "medium");
    let err = command::parse(&args(&["note", "1", "hi"])).unwrap_err();
    assert_eq!(err, "Unknown command \"note\". Run vboard help.");
    assert!(!command::USAGE.contains("note"));
    // Older skill copies still pass a summary after the number; it is accepted and dropped.
    let cmd = command::parse(&args(&["done", "1", "fixed", "it"])).unwrap();
    assert_eq!(command::execute(&conn, PROJECT, S1, cmd).unwrap().0["column"], "done");
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
fn move_to_unknown_column_lists_the_board_columns() {
    let conn = db();
    add(&conn, "a", "medium");
    let cmd = command::parse(&args(&["move", "1", "doing"])).unwrap();
    let err = command::execute(&conn, PROJECT, S1, cmd).unwrap_err();
    assert_eq!(err, "Column \"doing\" not found. Columns: Backlog, To Do, In Progress, Done.");
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
    review(&conn, true);
    let card = |column: &str| NewCard { title: "Fixed it".into(), column: Some(column.into()), ..Default::default() };
    let err = store::create_card(&conn, PROJECT, card("done"), &Actor::Agent(S1.into())).unwrap_err();
    assert_eq!(err, "Review is on: use vboard done; a person moves cards to Done.");
    assert_eq!(store::create_card(&conn, PROJECT, card("done"), &Actor::User).unwrap()["column"], "done");
    review(&conn, false);
    assert_eq!(store::create_card(&conn, PROJECT, card("done"), &Actor::Agent(S1.into())).unwrap()["column"], "done");
}

// ── editable columns ──

#[test]
fn old_review_setting_seeds_a_review_column() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(crate::db::schema::SCHEMA).unwrap();
    conn.execute_batch(
        "INSERT INTO projects(id,name,root_path,created_at) VALUES('p1','Demo','C:/demo',0);
         CREATE TABLE board_boards(project_id TEXT PRIMARY KEY, review_enabled INTEGER NOT NULL DEFAULT 0, next_number INTEGER NOT NULL DEFAULT 1);
         INSERT INTO board_boards(project_id, review_enabled) VALUES('p1', 1);",
    )
    .unwrap();
    super::init(&conn).unwrap();
    // After the upgrade the board lives under its folder (gone here, so the stored path).
    let ids: Vec<String> = store::columns(&conn, "C:/demo").unwrap().iter().map(|c| c["id"].as_str().unwrap().to_string()).collect();
    assert_eq!(ids, vec!["backlog", "todo", "in_progress", "review", "done"]);
}

#[test]
fn old_database_gains_the_color_column() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(crate::db::schema::SCHEMA).unwrap();
    conn.execute_batch(
        "CREATE TABLE board_cards (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, number INTEGER NOT NULL,
         column_id TEXT NOT NULL, position REAL NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL,
         description TEXT NOT NULL DEFAULT '', priority TEXT NOT NULL DEFAULT 'medium', claimed_by TEXT,
         created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_kind TEXT NOT NULL, updated_session TEXT,
         UNIQUE(project_id, number));",
    )
    .unwrap();
    super::init(&conn).unwrap();
    let has: bool = conn
        .query_row("SELECT COUNT(*) FROM pragma_table_info('board_cards') WHERE name='color'", [], |r| r.get::<_, i64>(0))
        .map(|n| n == 1)
        .unwrap();
    assert!(has);
}

#[test]
fn custom_columns_can_be_added_renamed_moved_and_deleted() {
    let conn = db();
    let qa = store::add_column(&conn, PROJECT, Some("QA"), None).unwrap();
    let qa_id = qa["id"].as_str().unwrap().to_string();
    assert!(qa_id.starts_with("c-"));
    assert_eq!(qa["role"], serde_json::Value::Null);
    assert_eq!(column_ids(&conn).last().unwrap(), &qa_id);
    store::rename_column(&conn, PROJECT, &qa_id, "  Testing ").unwrap();
    assert_eq!(store::columns(&conn, PROJECT).unwrap().last().unwrap()["name"], "Testing");
    store::move_column(&conn, PROJECT, &qa_id, Some("done")).unwrap();
    assert_eq!(column_ids(&conn), vec!["backlog", "todo", "in_progress", qa_id.as_str(), "done"]);
    store::delete_column(&conn, PROJECT, &qa_id, &Actor::User).unwrap();
    assert_eq!(column_ids(&conn), vec!["backlog", "todo", "in_progress", "done"]);
}

#[test]
fn column_names_are_unique_and_roles_appear_once() {
    let conn = db();
    store::add_column(&conn, PROJECT, Some("QA"), None).unwrap();
    assert_eq!(store::add_column(&conn, PROJECT, Some("qa"), None).unwrap_err(), "A column named \"qa\" already exists.");
    assert_eq!(store::add_column(&conn, PROJECT, Some("to do"), None).unwrap_err(), "A column named \"to do\" already exists.");
    assert!(store::add_column(&conn, PROJECT, None, Some("todo")).is_err());
    assert!(store::add_column(&conn, PROJECT, Some(" "), None).is_err());
}

#[test]
fn deleting_a_column_moves_its_cards_to_backlog() {
    let conn = db();
    add(&conn, "a", "medium");
    store::claim(&conn, PROJECT, 1, S1).unwrap();
    store::delete_column(&conn, PROJECT, "in_progress", &Actor::User).unwrap();
    let card = store::card_detail(&conn, PROJECT, 1).unwrap();
    assert_eq!(card["column"], "backlog");
    assert_eq!(card["claimedBy"], serde_json::Value::Null);
}

#[test]
fn backlog_cannot_be_renamed_moved_or_deleted() {
    let conn = db();
    let qa = store::add_column(&conn, PROJECT, Some("QA"), None).unwrap();
    let qa_id = qa["id"].as_str().unwrap();
    assert!(store::delete_column(&conn, PROJECT, "backlog", &Actor::User).is_err());
    assert!(store::rename_column(&conn, PROJECT, "backlog", "Ideas").is_err());
    assert!(store::move_column(&conn, PROJECT, "backlog", None).is_err());
    assert!(store::move_column(&conn, PROJECT, qa_id, Some("backlog")).is_err());
    assert_eq!(column_ids(&conn)[0], "backlog");
}

#[test]
fn next_and_done_follow_roles_after_renames() {
    let conn = db();
    add(&conn, "a", "medium");
    store::rename_column(&conn, PROJECT, "todo", "Ready").unwrap();
    store::rename_column(&conn, PROJECT, "done", "Shipped").unwrap();
    assert_eq!(store::claim_next(&conn, PROJECT, S1).unwrap().unwrap()["column"], "in_progress");
    assert_eq!(store::finish(&conn, PROJECT, 1, S1).unwrap()["column"], "done");
}

#[test]
fn next_needs_a_to_do_column() {
    let conn = db();
    store::delete_column(&conn, PROJECT, "todo", &Actor::User).unwrap();
    assert_eq!(store::claim_next(&conn, PROJECT, S1).unwrap_err(), "This board has no To Do column.");
    store::add_column(&conn, PROJECT, None, Some("todo")).unwrap();
    assert!(store::claim_next(&conn, PROJECT, S1).unwrap().is_none());
}

#[test]
fn vboard_moves_by_display_name_and_lists_columns() {
    let conn = db();
    add(&conn, "a", "medium");
    store::add_column(&conn, PROJECT, Some("In Review"), None).unwrap();
    let cmd = command::parse(&args(&["move", "1", "in", "review"])).unwrap();
    let (card, _) = command::execute(&conn, PROJECT, S1, cmd).unwrap();
    assert!(card["column"].as_str().unwrap().starts_with("c-"));
    let cmd = command::parse(&args(&["move", "1", "To", "Do"])).unwrap();
    assert_eq!(command::execute(&conn, PROJECT, S1, cmd).unwrap().0["column"], "todo");
    let (list, changed) = command::execute(&conn, PROJECT, S1, command::parse(&args(&["columns"])).unwrap()).unwrap();
    assert!(!changed);
    let names: Vec<&str> = list.as_array().unwrap().iter().map(|c| c["name"].as_str().unwrap()).collect();
    assert_eq!(names, vec!["Backlog", "To Do", "In Progress", "Done", "In Review"]);
    assert_eq!(list[1]["cards"], 1);
}

#[test]
fn card_colour_can_be_set_cleared_and_is_checked() {
    let conn = db();
    let card = store::create_card(
        &conn,
        PROJECT,
        NewCard { title: "a".into(), color: Some("green".into()), ..Default::default() },
        &Actor::User,
    )
    .unwrap();
    assert_eq!(card["color"], "green");
    let cleared = store::update_card(&conn, PROJECT, 1, CardPatch { color: Some("".into()), ..Default::default() }, &Actor::User).unwrap();
    assert_eq!(cleared["color"], serde_json::Value::Null);
    let bad = CardPatch { color: Some("teal".into()), ..Default::default() };
    assert!(store::update_card(&conn, PROJECT, 1, bad, &Actor::User).is_err());
    let cmd = command::parse(&args(&["add", "b", "--color", "pink"])).unwrap();
    assert_eq!(command::execute(&conn, PROJECT, S1, cmd).unwrap().0["color"], "pink");
}

// ── the board belongs to the folder ──

#[test]
fn board_survives_project_deletion() {
    let conn = db();
    add(&conn, "kept", "medium");
    store::add_column(&conn, PROJECT, Some("QA"), None).unwrap();
    conn.execute("DELETE FROM projects WHERE id='p1'", []).unwrap();
    let board = store::get_board(&conn, PROJECT).unwrap();
    assert_eq!(board["cards"][0]["title"], "kept");
    assert!(board["columns"].as_array().unwrap().iter().any(|c| c["name"] == "QA"));
}

#[test]
fn migrates_project_keyed_tables() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
    conn.execute_batch(crate::db::schema::SCHEMA).unwrap();
    conn.execute_batch(
        "INSERT INTO projects(id,name,root_path,created_at) VALUES('p1','Demo','C:/no/such/folder',0);
         CREATE TABLE board_boards (project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
           review_enabled INTEGER NOT NULL DEFAULT 0, next_number INTEGER NOT NULL DEFAULT 1);
         CREATE TABLE board_columns (project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
           id TEXT NOT NULL, name TEXT, role TEXT, position REAL NOT NULL, PRIMARY KEY(project_id, id));
         CREATE TABLE board_cards (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
           number INTEGER NOT NULL, column_id TEXT NOT NULL, position REAL NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL,
           description TEXT NOT NULL DEFAULT '', priority TEXT NOT NULL DEFAULT 'medium', claimed_by TEXT, color TEXT,
           created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_kind TEXT NOT NULL, updated_session TEXT,
           UNIQUE(project_id, number));
         INSERT INTO board_boards(project_id, next_number) VALUES('p1', 8);
         INSERT INTO board_columns VALUES('p1','backlog',NULL,'backlog',0),('p1','todo','Ready','todo',1),('p1','c-qa','QA',NULL,2);
         INSERT INTO board_cards(id,project_id,number,column_id,position,type,title,created_at,updated_at,updated_kind)
           VALUES('card1','p1',7,'c-qa',1,'bug','Old card',0,0,'user');",
    )
    .unwrap();
    super::init(&conn).unwrap();
    // The folder is gone, so the key is the stored root path as written.
    let key = "C:/no/such/folder";
    let board = store::get_board(&conn, key).unwrap();
    let ids: Vec<&str> = board["columns"].as_array().unwrap().iter().map(|c| c["id"].as_str().unwrap()).collect();
    assert_eq!(ids, vec!["backlog", "todo", "c-qa"]);
    assert_eq!(board["columns"][1]["name"], "Ready");
    assert_eq!(board["cards"][0]["title"], "Old card");
    assert_eq!(board["cards"][0]["column"], "c-qa");
    let next = store::create_card(&conn, key, NewCard { title: "New".into(), ..Default::default() }, &Actor::User).unwrap();
    assert_eq!(next["number"], 8);
    let old_column: i64 = conn
        .query_row("SELECT COUNT(*) FROM pragma_table_info('board_cards') WHERE name='project_id'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(old_column, 0);
    conn.execute("DELETE FROM projects WHERE id='p1'", []).unwrap();
    assert_eq!(store::get_board(&conn, key).unwrap()["cards"].as_array().unwrap().len(), 2);
}

#[test]
fn board_key_is_the_canonical_folder() {
    let dir = std::env::temp_dir().join(format!("board-key-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let canonical = dir.canonicalize().unwrap().to_string_lossy().to_string();
    let spelled = format!("{}/", dir.to_string_lossy().replace('\\', "/"));
    assert_eq!(store::folder_key(&spelled), canonical);
    assert_eq!(store::folder_key("C:/no/such/folder"), "C:/no/such/folder");
    let _ = std::fs::remove_dir_all(&dir);
}

// ── pasted images ──

#[test]
fn board_images_save_and_link_by_absolute_path() {
    use super::images;
    let dir = std::env::temp_dir().join(format!("board-images-test-{}", uuid::Uuid::new_v4())).join("board-images");
    let path = images::save(&dir, b"png-bytes", "PNG").unwrap();
    assert!(!path.contains('\\'));
    assert!(path.ends_with(".png"));
    assert_eq!(std::fs::read(&path).unwrap(), b"png-bytes");
    let evil = images::save(&dir, b"x", "../exe").unwrap();
    assert!(evil.ends_with(".exe") && evil.contains("/board-images/"));
    let name = path.rsplit('/').next().unwrap().to_string();
    let text = format!("See ![image](<{path}>) and board-images/../secret and board-images/.hidden");
    assert_eq!(images::names(&text), std::collections::HashSet::from([name]));
    let _ = std::fs::remove_dir_all(dir.parent().unwrap());
}

#[test]
fn board_images_sweep_keeps_linked_and_recent_files() {
    use super::images;
    let conn = db();
    let dir = std::env::temp_dir().join(format!("board-images-test-{}", uuid::Uuid::new_v4())).join("board-images");
    let linked = images::save(&dir, b"a", "png").unwrap();
    let orphan = images::save(&dir, b"b", "png").unwrap();
    let recent = images::save(&dir, b"c", "png").unwrap();
    let old = std::time::SystemTime::now() - std::time::Duration::from_secs(2 * 24 * 60 * 60);
    for path in [&linked, &orphan] {
        std::fs::File::options().write(true).open(path).unwrap().set_modified(old).unwrap();
    }
    store::create_card(
        &conn,
        PROJECT,
        NewCard { title: "shot".into(), description: format!("![image](<{linked}>)"), ..Default::default() },
        &Actor::User,
    )
    .unwrap();
    assert_eq!(images::sweep(&conn, &dir).unwrap(), 1);
    assert!(std::path::Path::new(&linked).exists());
    assert!(!std::path::Path::new(&orphan).exists());
    assert!(std::path::Path::new(&recent).exists());
    // Once the card is deleted, its old image goes too.
    store::delete_card(&conn, PROJECT, 1, &Actor::User).unwrap();
    assert_eq!(images::sweep(&conn, &dir).unwrap(), 1);
    assert!(!std::path::Path::new(&linked).exists());
    let _ = std::fs::remove_dir_all(dir.parent().unwrap());
}
