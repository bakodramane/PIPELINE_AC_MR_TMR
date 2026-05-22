/// AgCensus Compiler — Tauri backend.
///
/// Session 14: wires the "Generate all" buttons to real Node.js generators
/// via tauri-plugin-shell.
///
/// Each generate_* command spawns:
///   node <tsx-cli.mjs> <src-tauri/scripts/generate.ts> --project ... --type ... ...
///
/// The child process writes one-line tokens to stdout:
///   STATUS:<msg>          informational
///   DONE:<n>              section/sub-table n finished successfully
///   ERROR:<n>:<msg>       section/sub-table n failed
///
/// As each line arrives the command emits a "generation-progress" Tauri event
/// so the frontend can update in real-time.  The command returns Ok(summary)
/// once the child exits.

use std::path::PathBuf;
use tauri::Emitter;
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;
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

    let mut args = vec![
        tsx_cli.to_string_lossy().into_owned(),
        script.to_string_lossy().into_owned(),
        "--project".to_string(),
        project_dir,
        "--type".to_string(),
        "mr".to_string(),
        "--model".to_string(),
        model,
    ];

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

    let mut args = vec![
        tsx_cli.to_string_lossy().into_owned(),
        script.to_string_lossy().into_owned(),
        "--project".to_string(),
        project_dir,
        "--type".to_string(),
        "tmr".to_string(),
        "--model".to_string(),
        model,
    ];

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
///
/// Spawns: node <tsx-cli.mjs> <src-tauri/scripts/export.mjs> --project ... --type ...
/// Reads stdout for `DONE:<path>` and returns that path.
/// Returns Err if `ERROR:<msg>` is received or the process exits without output.
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
///
/// `claims_json` is a JSON string of the shape `{ "claims": [...] }`.
/// The command:
///   - Reads the full `_claims.json`
///   - Replaces the `section_<n>` key with the new section data
///   - Sets `approved: false` on the section (editing resets approval)
///   - Writes back as pretty-printed JSON with no BOM
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
///
/// Fails if the section key does not exist in `_claims.json`
/// (the section must have been generated before it can be approved).
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
///
/// Used by the Audit log viewer to open a JSONL file in the system's
/// default text editor.  Delegates to tauri-plugin-shell's `open()`.
#[tauri::command]
fn open_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    app.shell()
        .open(&path, None::<String>)
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Create project command
// ---------------------------------------------------------------------------

/// Create a new country project directory with all required subdirectories and
/// skeleton JSON files.  Uses Rust std::fs so every file is written as raw
/// UTF-8 bytes — no BOM, unlike PowerShell WriteAllText.
///
/// Directories created:
///   evidence/pages  evidence/tables  drafts/mr  drafts/tmr  sources  audit
///
/// Files written:
///   manifest.json              ← the JSON string passed in
///   evidence/_evidence.json    ← {"pages":[],"tables":[]}
///   drafts/mr/_claims.json     ← {}
///   drafts/tmr/_cells.json     ← {}
///   sources/_index.json        ← []
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
        .invoke_handler(tauri::generate_handler![
            generate_mr_sections,
            generate_tmr_subtable,
            create_project,
            export_project,
            save_mr_section,
            approve_mr_section,
            open_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running AgCensus Compiler");
}
