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
// App entry point
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            generate_mr_sections,
            generate_tmr_subtable
        ])
        .run(tauri::generate_context!())
        .expect("error while running AgCensus Compiler");
}
