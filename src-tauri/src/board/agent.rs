//! `vboard`: the command shim posts its arguments to `/board` on the authenticated loopback channel, and the
//! app runs them against the board of the caller's project.
use super::command;
use crate::host::AppCtx;
use serde_json::{json, Value};
use std::io::Read;
use std::time::{Duration, Instant};

const OUTSIDE: &str = "Run vboard inside an mTerm session.";

fn run_request(app: &AppCtx, body: &Value) -> Result<Value, String> {
    let sid = body["sessionId"].as_str().ok_or(OUTSIDE)?;
    let args: Vec<String> = body["args"]
        .as_array()
        .map(|items| items.iter().filter_map(|a| a.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    let cmd = command::parse(&args)?;
    let (value, changed, project) = {
        let conn = app.db().conn.lock().map_err(|e| e.to_string())?;
        let session = crate::db::repo::get_session(&conn, sid)?.ok_or(OUTSIDE)?;
        let key = super::board_key(&conn, &session.project_id)?;
        let (value, changed) = command::execute(&conn, &key, sid, cmd)?;
        (value, changed, session.project_id)
    };
    if changed {
        super::announce(app, &project);
    }
    Ok(value)
}

pub fn handle(app: AppCtx, mut request: crate::diagnostics::HttpRequest, token: String) {
    let started = Instant::now();
    let method = request.method().as_str().to_string();
    let request_id = request.id().to_string();
    let authorized =
        request.headers().iter().any(|h| h.field.equiv("Authorization") && h.value.as_str() == format!("Bearer {token}"));
    let mut body = String::new();
    let result = if !authorized {
        Err((401, "Not authorized.".to_string()))
    } else if request.method() != &tiny_http::Method::Post {
        Err((405, "Use POST.".to_string()))
    } else if request.as_reader().take(16_385).read_to_string(&mut body).is_err() || body.len() > 16_384 {
        Err((413, "The request is too large.".to_string()))
    } else {
        serde_json::from_str(&body)
            .map_err(|_| "Invalid request.".to_string())
            .and_then(|args| run_request(&app, &args))
            .map_err(|e| (400, e))
    };
    let (status, value) = match result {
        Ok(value) => (200, json!({ "result": value })),
        Err((status, error)) => (status, json!({ "error": error })),
    };
    let response = tiny_http::Response::from_string(value.to_string())
        .with_status_code(status)
        .with_header(tiny_http::Header::from_bytes("Content-Type", "application/json").unwrap());
    let _ = request.respond(response);
    crate::diagnostics::record(
        if status == 200 { "INFO" } else { "WARN" },
        "board_http",
        json!({ "requestId": request_id, "method": method, "statusCode": status, "durationMs": started.elapsed().as_millis() as u64 }),
    );
}

pub fn run(args: &[String]) -> ! {
    let rest = &args[args.len().min(2)..];
    if rest.is_empty() || matches!(rest[0].as_str(), "help" | "--help" | "-h") {
        println!("{}", command::USAGE);
        std::process::exit(0);
    }
    let result = (|| -> Result<Value, String> {
        let base = std::env::var("VLX_SPAWN_URL").map_err(|_| OUTSIDE)?;
        let sid = std::env::var("VLX_SESSION_ID").map_err(|_| OUTSIDE)?;
        let token = std::env::var("VLX_TOKEN").map_err(|_| OUTSIDE)?;
        let url = url::Url::parse(&base).map_err(|_| OUTSIDE)?;
        if url.scheme() != "http" || !matches!(url.host_str(), Some("127.0.0.1" | "localhost")) {
            return Err(OUTSIDE.into());
        }
        let body = json!({ "sessionId": sid, "args": rest });
        let request = ureq::AgentBuilder::new()
            .timeout(Duration::from_secs(30))
            .build()
            .post(&format!("{base}/board"))
            .set("Authorization", &format!("Bearer {token}"))
            .set("Content-Type", "application/json")
            .send_string(&body.to_string());
        let response = match request {
            Ok(r) => r,
            Err(ureq::Error::Status(_, r)) => r,
            Err(_) => return Err("Cannot reach mTerm. Is the app running?".into()),
        };
        let mut text = String::new();
        response.into_reader().take(8 * 1024 * 1024).read_to_string(&mut text).map_err(|_| "Cannot read the board response.")?;
        let value: Value = serde_json::from_str(&text).map_err(|_| "Invalid board response.")?;
        if let Some(error) = value["error"].as_str() {
            return Err(error.into());
        }
        Ok(value["result"].clone())
    })();
    match result {
        Ok(Value::String(text)) => {
            println!("{text}");
            std::process::exit(0)
        }
        Ok(value) => {
            println!("{}", serde_json::to_string_pretty(&value).unwrap());
            std::process::exit(0)
        }
        Err(error) => {
            eprintln!("vboard: {error}");
            std::process::exit(1)
        }
    }
}
