/// AgCensus Compiler — Tauri backend.
///
/// Session 14: wires the "Generate all" buttons to real Node.js generators
/// via tauri-plugin-shell.
///
/// Session 18: adds save_api_key / get_api_key commands (tauri-plugin-store),
/// passes --provider / --api-key args to generator child process, and
/// registers tauri-plugin-store in the Tauri builder.

use std::path::PathBuf;
use tauri::Emitter;
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_store::StoreExt;
use serde::Serialize;

// ---------------------------------------------------------------------------
// Event payload — serialised and forwarded to the frontend
// ---------------------------------------------------------------------------

/// Payload of the "generation-progress" global Tauri event.
#[derive(Serialize, Clone)]
struct GenerationProgressPayload {
    /// "mr" | "tmr"
    #[serde(rename = "type")]
    gen_type: String,
    /// Section or sub-table number that just completed.
    number: u32,
    /// "done" | "error"
    status: String,
    /// Only set when status == "error".
    message: Option<String>,
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/// Returns (tsx_cli_path, generate_script_path).
///
/// CARGO_MANIFEST_DIR is the compile-time path to `src-tauri/`.
/// Its parent is the PIPELINE root, where node_modules lives.
fn generator_paths() -> (PathBuf, PathBuf) {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR")); // …/src-tauri
    let root = manifest
        .parent()
        .expect("src-tauri must have a parent directory")
        .to_path_buf(); // …/PIPELINE
    let tsx_cli = root
        .join("node_modules")
        .join("tsx")
        .join("dist")
        .join("cli.mjs");
    let script = manifest.join("scripts").join("generate.ts");
    (tsx_cli, script)
}

// ---------------------------------------------------------------------------
// Provider helpers
// ---------------------------------------------------------------------------

fn provider_for_model(model: &str) -> &'static str {
    if model.starts_with("deepseek-") { return "deepseek"; }
    if model.starts_with("kimi-")     { return "kimi"; }
    if model.starts_with("gemini-")   { return "google"; }
    if model.starts_with("gpt-")      { return "openai"; }
    if model.starts_with("claude-")   { return "anthropic"; }
    "deepseek" // safe fallback
}

/// Read a stored API key from the app store.  Returns None if absent or on error.
fn read_api_key_from_store(app: &tauri::AppHandle, provider: &str) -> Option<String> {
    app.store("api_keys.json")
        .ok()
        .and_then(|store| store.get(provider))
        .and_then(|v| v.as_str().map(String::from))
}

// ---------------------------------------------------------------------------
// API key commands (Session 18)
// ---------------------------------------------------------------------------

/// Persist an API key for a provider in the app-local encrypted store.
///
/// `provider` must be one of: deepseek | kimi | google | openai | anthropic
#[tauri::command]
fn save_api_key(
    app: tauri::AppHandle,
    provider: String,
    key: String,
) -> Result<(), String> {
    let store = app.store("api_keys.json").map_err(|e| e.to_string())?;
    store.set(provider, serde_json::json!(key));
    store.save().map_err(|e| e.to_string())
}

/// Read a stored API key for a provider.  Returns None if no key is saved.
#[tauri::command]
fn get_api_key(
    app: tauri::AppHandle,
    provider: String,
) -> Result<Option<String>, String> {
    let store = app.store("api_keys.json").map_err(|e| e.to_string())?;
    Ok(store.get(&provider).and_then(|v| v.as_str().map(String::from)))
}

// ---------------------------------------------------------------------------
// MR command
// ---------------------------------------------------------------------------

/// Generate one or all MR sections.
///
/// `section == None`    → generate all 15 sections sequentially
/// `section == Some(n)` → generate section n only
#[tauri::command]
async fn generate_mr_sections(
    app: tauri::AppHandle,
    project_dir: String,
    section: Option<u32>,
    model: String,
) -> Result<String, String> {
    let (tsx_cli, script) = generator_paths();

    // Determine the provider and look up any stored API key
    let provider = provider_for_model(&model);
    let api_key  = read_api_key_from_store(&app, provider);

    let mut args = vec![
        tsx_cli.to_string_lossy().into_owned(),
        script.to_string_lossy().into_owned(),
        "--project".to_string(),
        project_dir,
        "--type".to_string(),
        "mr".to_string(),
        "--model".to_string(),
        model,
        "--provider".to_string(),
        provider.to_string(),
    ];

    // Only pass --api-key when we actually have a stored key; otherwise the
    // Node script will fall back to process.env / the .env file.
    if let Some(ref key) = api_key {
        args.extend(["--api-key".to_string(), key.clone()]);
    }

    let total: u32 = if let Some(n) = section {
        args.extend(["--section".to_string(), n.to_string()]);
        1
    } else {
        args.push("--all".to_string());
        15
    };

    let (mut rx, _child) = app
        .shell()
        .command("node")
        .args(&args)
        .spawn()
        .map_err(|e| format!("Failed to spawn node generator: {e}"))?;

    let mut buf = String::new();
    let mut done_count: u32 = 0;

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                buf.push_str(&String::from_utf8_lossy(&bytes));
                // Process every complete \n-terminated line
                while let Some(pos) = buf.find('\n') {
                    let line = buf[..pos].trim_end_matches('\r').to_string();
                    buf = buf[pos + 1..].to_string();

                    if let Some(rest) = line.strip_prefix("DONE:") {
                        if let Ok(n) = rest.trim().parse::<u32>() {
                            done_count += 1;
                            let _ = app.emit(
                                "generation-progress",
                                GenerationProgressPayload {
                                    gen_type: "mr".to_string(),
                                    number: n,
                                    status: "done".to_string(),
                                    message: None,
                                },
                            );
                        }
                    } else if let Some(rest) = line.strip_prefix("ERROR:") {
                        let mut parts = rest.splitn(2, ':');
                        let n = parts
                            .next()
                            .and_then(|s| s.trim().parse::<u32>().ok())
                            .unwrap_or(0);
                        let msg = parts.next().unwrap_or("unknown error").to_string();
                        done_count += 1;
                        let _ = app.emit(
                            "generation-progress",
                            GenerationProgressPayload {
                                gen_type: "mr".to_string(),
                                number: n,
                                status: "error".to_string(),
                                message: Some(msg),
                            },
                        );
                    }
                    // STATUS: lines are informational — not forwarded as events
                }
            }
            CommandEvent::Stderr(_) => {
                // Ignore stderr — generator errors surface via ERROR: stdout lines
            }
            CommandEvent::Terminated(_) | CommandEvent::Error(_) => break,
            _ => {}
        }
    }

    Ok(format!("{done_count}/{total} sections processed"))
}

// ---------------------------------------------------------------------------
// TMR command
// ---------------------------------------------------------------------------

/// Generate one or all TMR sub-tables.
///
/// `sub_table_number == 0`  → generate all 23 sub-tables sequentially
/// `sub_table_number >= 1`  → generate that sub-table only
#[tauri::command]
async fn generate_tmr_subtable(
    app: tauri::AppHandle,
    project_dir: String,
    sub_table_number: i32,
    model: String,
) -> Result<String, String> {
    let (tsx_cli, script) = generator_paths();

    let provider = provider_for_model(&model);
    let api_key  = read_api_key_from_store(&app, provider);

    let mut args = vec![
        tsx_cli.to_string_lossy().into_owned(),
        script.to_string_lossy().into_owned(),
        "--project".to_string(),
        project_dir,
        "--type".to_string(),
        "tmr".to_string(),
        "--model".to_string(),
        model,
        "--provider".to_string(),
        provider.to_string(),
    ];

    if let Some(ref key) = api_key {
        args.extend(["--api-key".to_string(), key.clone()]);
    }

    let total: u32 = if sub_table_number == 0 {
        args.push("--all".to_string());
        23
    } else {
        args.extend([
            "--subtable".to_string(),
            sub_table_number.to_string(),
        ]);
        1
    };

    let (mut rx, _child) = app
        .shell()
        .command("node")
        .args(&args)
        .spawn()
        .map_err(|e| format!("Failed to spawn node generator: {e}"))?;

    let mut buf = String::new();
    let mut done_count: u32 = 0;

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                buf.push_str(&String::from_utf8_lossy(&bytes));
                while let Some(pos) = buf.find('\n') {
                    let line = buf[..pos].trim_end_matches('\r').to_string();
                    buf = buf[pos + 1..].to_string();

                    if let Some(rest) = line.strip_prefix("DONE:") {
                        if let Ok(n) = rest.trim().parse::<u32>() {
                            done_count += 1;
                            let _ = app.emit(
                                "generation-progress",
                                GenerationProgressPayload {
                                    gen_type: "tmr".to_string(),
                                    number: n,
                                    status: "done".to_string(),
                                    message: None,
                                },
                            );
                        }
                    } else if let Some(rest) = line.strip_prefix("ERROR:") {
                        let mut parts = rest.splitn(2, ':');
                        let n = parts
                            .next()
                            .and_then(|s| s.trim().parse::<u32>().ok())
                            .unwrap_or(0);
                        let msg = parts.next().unwrap_or("unknown error").to_string();
                        done_count += 1;
                        let _ = app.emit(
                            "generation-progress",
                            GenerationProgressPayload {
                                gen_type: "tmr".to_string(),
                                number: n,
                                status: "error".to_string(),
                                message: Some(msg),
                            },
                        );
                    }
                }
            }
            CommandEvent::Stderr(_) => {}
            CommandEvent::Terminated(_) | CommandEvent::Error(_) => break,
            _ => {}
        }
    }

    Ok(format!("{done_count}/{total} sub-tables processed"))
}

// ---------------------------------------------------------------------------
// Export command
// ---------------------------------------------------------------------------

/// Export a country project to a file.
///
/// `export_type == "tmr"` → writes exports/<iso3>-tmr-<date>.xlsx via exportTmr
/// `export_type == "mr"`  → writes exports/<iso3>-mr-<date>.md   via exportMr
#[tauri::command]
async fn export_project(
    app: tauri::AppHandle,
    project_dir: String,
    export_type: String,
) -> Result<String, String> {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR")); // …/src-tauri
    let root = manifest
        .parent()
        .expect("src-tauri must have a parent directory")
        .to_path_buf(); // …/PIPELINE

    let tsx_cli = root
        .join("node_modules")
        .join("tsx")
        .join("dist")
        .join("cli.mjs");
    let script = manifest.join("scripts").join("export.mjs");

    let args = vec![
        tsx_cli.to_string_lossy().into_owned(),
        script.to_string_lossy().into_owned(),
        "--project".to_string(),
        project_dir,
        "--type".to_string(),
        export_type,
    ];

    let (mut rx, _child) = app
        .shell()
        .command("node")
        .args(&args)
        .spawn()
        .map_err(|e| format!("Failed to spawn export: {e}"))?;

    let mut buf = String::new();
    let mut output_path = String::new();
    let mut error_msg = String::new();

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                buf.push_str(&String::from_utf8_lossy(&bytes));
                while let Some(pos) = buf.find('\n') {
                    let line = buf[..pos].trim_end_matches('\r').to_string();
                    buf = buf[pos + 1..].to_string();
                    if let Some(rest) = line.strip_prefix("DONE:") {
                        output_path = rest.trim().to_string();
                    } else if let Some(rest) = line.strip_prefix("ERROR:") {
                        error_msg = rest.trim().to_string();
                    }
                }
            }
            CommandEvent::Stderr(_) => {}
            CommandEvent::Terminated(_) | CommandEvent::Error(_) => break,
            _ => {}
        }
    }

    if !error_msg.is_empty() {
        Err(error_msg)
    } else if !output_path.is_empty() {
        Ok(output_path)
    } else {
        Err("Export completed with no output path reported".to_string())
    }
}

// ---------------------------------------------------------------------------
// Save MR section command
// ---------------------------------------------------------------------------

/// Write updated claims for one MR section back to `drafts/mr/_claims.json`.
#[tauri::command]
fn save_mr_section(
    project_dir: String,
    section_number: u32,
    claims_json: String,
) -> Result<(), String> {
    use std::fs;
    use std::path::Path;

    let claims_path = Path::new(&project_dir)
        .join("drafts")
        .join("mr")
        .join("_claims.json");

    let raw = fs::read_to_string(&claims_path)
        .map_err(|e| format!("Failed to read _claims.json: {e}"))?;

    let mut all_claims: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| format!("Failed to parse _claims.json: {e}"))?;

    let mut new_section: serde_json::Value = serde_json::from_str(&claims_json)
        .map_err(|e| format!("Failed to parse claims_json: {e}"))?;

    // Editing resets the approved flag — guard against approving stale content.
    if let Some(obj) = new_section.as_object_mut() {
        obj.insert("approved".to_string(), serde_json::Value::Bool(false));
    }

    let key = format!("section_{section_number}");
    if let Some(obj) = all_claims.as_object_mut() {
        obj.insert(key, new_section);
    }

    let updated = serde_json::to_string_pretty(&all_claims)
        .map_err(|e| format!("Failed to serialize _claims.json: {e}"))?;

    fs::write(&claims_path, updated.as_bytes())
        .map_err(|e| format!("Failed to write _claims.json: {e}"))?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Approve MR section command
// ---------------------------------------------------------------------------

/// Set `approved: true` on one MR section in `drafts/mr/_claims.json`.
#[tauri::command]
fn approve_mr_section(
    project_dir: String,
    section_number: u32,
) -> Result<(), String> {
    use std::fs;
    use std::path::Path;

    let claims_path = Path::new(&project_dir)
        .join("drafts")
        .join("mr")
        .join("_claims.json");

    let raw = fs::read_to_string(&claims_path)
        .map_err(|e| format!("Failed to read _claims.json: {e}"))?;

    let mut all_claims: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| format!("Failed to parse _claims.json: {e}"))?;

    let key = format!("section_{section_number}");
    if all_claims.get(&key).is_none() {
        return Err(format!(
            "Section {section_number} not found — generate it before approving."
        ));
    }

    if let Some(section) = all_claims.get_mut(&key) {
        if let Some(obj) = section.as_object_mut() {
            obj.insert("approved".to_string(), serde_json::Value::Bool(true));
        }
    }

    let updated = serde_json::to_string_pretty(&all_claims)
        .map_err(|e| format!("Failed to serialize _claims.json: {e}"))?;

    fs::write(&claims_path, updated.as_bytes())
        .map_err(|e| format!("Failed to write _claims.json: {e}"))?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Open path command
// ---------------------------------------------------------------------------

/// Open a file or directory with the OS default application.
#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    std::process::Command::new("explorer")
        .arg(&path)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Create project command
// ---------------------------------------------------------------------------

/// Create a new country project directory with all required subdirectories
/// and skeleton JSON files.
#[tauri::command]
fn create_project(project_dir: String, manifest: String) -> Result<String, String> {
    use std::fs;
    use std::path::Path;

    let base = Path::new(&project_dir);

    for dir in &[
        "evidence/pages",
        "evidence/tables",
        "drafts/mr",
        "drafts/tmr",
        "sources",
        "audit",
    ] {
        fs::create_dir_all(base.join(dir))
            .map_err(|e| format!("Failed to create directory '{dir}': {e}"))?;
    }

    fs::write(base.join("manifest.json"), manifest.as_bytes())
        .map_err(|e| format!("Failed to write manifest.json: {e}"))?;

    fs::write(
        base.join("evidence/_evidence.json"),
        br#"{"pages":[],"tables":[]}"#,
    )
    .map_err(|e| format!("Failed to write evidence/_evidence.json: {e}"))?;

    fs::write(base.join("drafts/mr/_claims.json"), b"{}")
        .map_err(|e| format!("Failed to write drafts/mr/_claims.json: {e}"))?;

    fs::write(base.join("drafts/tmr/_cells.json"), b"{}")
        .map_err(|e| format!("Failed to write drafts/tmr/_cells.json: {e}"))?;

    fs::write(base.join("sources/_index.json"), b"[]")
        .map_err(|e| format!("Failed to write sources/_index.json: {e}"))?;

    Ok(project_dir)
}

// ---------------------------------------------------------------------------
// App entry point
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            generate_mr_sections,
            generate_tmr_subtable,
            create_project,
            export_project,
            save_mr_section,
            approve_mr_section,
            open_path,
            save_api_key,
            get_api_key,
        ])
        .run(tauri::generate_context!())
        .expect("error while running AgCensus Compiler");
}
