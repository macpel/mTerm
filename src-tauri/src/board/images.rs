//! Images pasted into card descriptions. Each one is a file in `<data dir>/board-images/` that the description
//! links by absolute path, so Claude sessions and `vboard show` can open it as-is.

use super::store::Result;
use rusqlite::Connection;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

const DIR: &str = "board-images";

/// Unlinked images younger than this are kept: they may sit in a description that has not been saved yet.
const GRACE: Duration = Duration::from_secs(24 * 60 * 60);

pub fn dir(data_dir: &Path) -> PathBuf {
    data_dir.join(DIR)
}

/// Saves an image under a fresh name and returns its absolute path with forward slashes, ready for Markdown.
pub fn save(dir: &Path, bytes: &[u8], ext: &str) -> Result<String> {
    let ext: String = ext.chars().filter(char::is_ascii_alphanumeric).take(8).collect::<String>().to_ascii_lowercase();
    let ext = if ext.is_empty() { "png".to_string() } else { ext };
    std::fs::create_dir_all(dir).map_err(|e| format!("Failed to create the board image folder: {e}"))?;
    let path = dir.join(format!("{}.{ext}", uuid::Uuid::new_v4()));
    std::fs::write(&path, bytes).map_err(|e| format!("Failed to write image: {e}"))?;
    Ok(path.to_string_lossy().replace('\\', "/"))
}

/// Whether `name` is a file name [`save`] could have produced: `<lowercase hyphenated uuid>.<1-8 alphanumerics>`.
/// Anything else (separators, `..`, drive or UNC prefixes) is refused before it can become a path.
pub fn valid_name(name: &str) -> bool {
    let Some((stem, ext)) = name.split_once('.') else { return false };
    stem.len() == 36
        && uuid::Uuid::parse_str(stem).is_ok_and(|id| id.hyphenated().to_string() == stem)
        && (1..=8).contains(&ext.len())
        && ext.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
}

/// Reads one board image by file name, as base64. Only files directly inside `dir` can be read: the name is
/// checked by [`valid_name`] and the resolved path must still sit in `dir` (no link out of it).
pub fn read(dir: &Path, name: &str) -> Result<String> {
    if !valid_name(name) {
        return Err("Not a board image.".into());
    }
    let dir = dir.canonicalize().map_err(|_| "Board image not found.".to_string())?;
    let path = dir.join(name).canonicalize().map_err(|_| "Board image not found.".to_string())?;
    if path.parent() != Some(dir.as_path()) || !path.is_file() {
        return Err("Not a board image.".into());
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("Failed to read image: {e}"))?;
    Ok(crate::agent::inject::base64_encode(&bytes))
}

/// File names of the board images `text` links to.
pub fn names(text: &str) -> HashSet<String> {
    let marker = format!("{DIR}/");
    text.match_indices(&marker)
        .map(|(at, _)| {
            text[at + marker.len()..]
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '.')
                .collect::<String>()
        })
        .filter(|name| !name.is_empty() && !name.starts_with('.'))
        .collect()
}

/// Deletes board images no card links to any more, once they are older than [`GRACE`].
pub fn sweep(conn: &Connection, dir: &Path) -> Result<usize> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Ok(0) };
    let mut stmt = conn
        .prepare("SELECT description FROM board_cards WHERE description LIKE '%board-images/%'")
        .map_err(|e| e.to_string())?;
    let used: HashSet<String> = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .filter_map(|d| d.ok())
        .flat_map(|d| names(&d))
        .collect();
    let now = SystemTime::now();
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Ok(meta) = entry.metadata() else { continue };
        let old = meta.modified().ok().and_then(|m| now.duration_since(m).ok()).is_some_and(|age| age >= GRACE);
        if meta.is_file() && old && !used.contains(&name) && std::fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}
