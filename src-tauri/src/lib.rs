/// AgCensus Compiler — Tauri backend.
///
/// Session 14: wires the "Generate all" buttons to real Node.js generators
/// via tauri-plugin-shell.
///
/// Session 18: adds save_api_key / get_api_key commands (tauri-plugin-store),
/// passes --provider / --api-key args to generator child process, and
/// registers tauri-plugin-store in the Tauri builder.
///
/// Session 24 (installer): adds production-mode path resolution so the app
/// can run pre-compiled ESM bundles from the Tauri resource directory instead
/// of relying on tsx + source files that are absent after installation.

use std::path::{Path, PathBuf};
use tauri::{Emitter, Manager};
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

/// Payload of the "ingest-progress" global Tauri event.
#[derive(Serialize, Clone)]
struct IngestProgressPayload {
    doc_id: String,
    /// "done" | "error"
    status: String,
    page_count: Option<u32>,
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
// Production-mode path helpers
// ---------------------------------------------------------------------------

/// True when `dir` is a complete dist-scripts directory: it must contain BOTH
/// the `generate.mjs` bundle AND the `references/mr-prompt-v1.3.md` data file.
///
/// Requiring the data marker (not just the bundle) guards against installer
/// layouts where the `.mjs` bundles ship but the `references/`, `mr-prompts/`,
/// and `concepts/` subfolders are missing or flattened — which previously
/// passed the bundle-only check and then crashed at generation time.
fn is_complete_scripts_dir(dir: &Path) -> bool {
    dir.join("generate.mjs").exists()
        && dir
            .join("references")
            .join("mr-prompt-v1.3.md")
            .exists()
}

/// Find the pre-compiled ESM bundle directory (production mode).
///
/// Probes every known installer/portable layout and returns the first
/// candidate that is a *complete* dist-scripts tree (bundles + data files).
/// Returns `Some(dir)` when running from an installed bundle, `None` in dev.
fn find_node_scripts_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    // Tauri resource_dir — different bundlers / glob forms place dist-scripts
    // at different sub-paths, so probe each variant:
    //   <resource_dir>/dist-scripts            (object-map directory copy)
    //   <resource_dir>/resources/dist-scripts  (some NSIS/MSI layouts)
    //   <resource_dir>/_up_/dist-scripts       (list-form "../" traversal)
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("dist-scripts"));
        candidates.push(resource_dir.join("resources").join("dist-scripts"));
        candidates.push(resource_dir.join("_up_").join("dist-scripts"));
    }

    // Portable layout: directory next to the executable.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            candidates.push(exe_dir.join("dist-scripts"));
        }
    }

    candidates
        .into_iter()
        .find(|dir| is_complete_scripts_dir(dir))
    // None → dev mode; caller falls back to tsx invocation.
}

/// Locate the Node.js binary on the current machine.
///
/// Checks well-known Windows install locations, then falls back to PATH.
/// Returns the full path on success, or `None` if Node is not found.
fn find_node_binary() -> Option<PathBuf> {
    // Portable mode: look for node.exe alongside the running executable
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            let portable_node = exe_dir.join("node.exe");
            if portable_node.exists() {
                return Some(portable_node);
            }
        }
    }

    // Well-known Windows install locations
    let candidates: Vec<PathBuf> = [
        std::env::var("ProgramFiles").ok()
            .map(|p| PathBuf::from(&p).join("nodejs").join("node.exe")),
        std::env::var("LOCALAPPDATA").ok()
            .map(|p| PathBuf::from(&p).join("Programs").join("nodejs").join("node.exe")),
    ]
    .into_iter()
    .flatten()
    .collect();

    for path in candidates {
        if path.exists() {
            return Some(path);
        }
    }

    // Try PATH via `where node` (Windows) / `which node` (Unix)
    #[cfg(target_os = "windows")]
    let where_cmd = ("where", "node");
    #[cfg(not(target_os = "windows"))]
    let where_cmd = ("which", "node");

    if let Ok(out) = std::process::Command::new(where_cmd.0)
        .arg(where_cmd.1)
        .output()
    {
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout);
            if let Some(line) = s.lines().next() {
                let p = PathBuf::from(line.trim());
                if p.exists() {
                    return Some(p);
                }
            }
        }
    }

    None
}

/// Resolve how to invoke a sidecar script: production bundle or dev tsx.
///
/// Returns `(node_binary, leading_args)` where leading_args contains the
/// bundle path (prod) or [tsx_cli, script_path] (dev).
fn resolve_invocation(
    app: &tauri::AppHandle,
    script_name: &str,
) -> Result<(String, Vec<String>), String> {
    if let Some(scripts_dir) = find_node_scripts_dir(app) {
        // Production: node dist-scripts/<stem>.mjs [args]
        let stem = Path::new(script_name)
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy();
        let bundle = scripts_dir.join(format!("{stem}.mjs"));
        let node = find_node_binary()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|| "node".to_string());
        Ok((node, vec![bundle.to_string_lossy().into_owned()]))
    } else {
        // Dev: node tsx_cli script_path [args]
        let (tsx_cli, _) = generator_paths();
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let script   = manifest.join("scripts").join(script_name);
        Ok((
            "node".to_string(),
            vec![
                tsx_cli.to_string_lossy().into_owned(),
                script.to_string_lossy().into_owned(),
            ],
        ))
    }
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
    if model.starts_with("azure-")    { return "azure"; }
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
    let (node_cmd, mut args) = resolve_invocation(&app, "generate.ts")?;

    // AGCENSUS_RESOURCE_ROOT is set in production so generator scripts can
    // locate prompt templates and the WCA concept registry via env var
    // instead of __dirname-relative paths (which change after bundling).
    let resource_root: Option<String> = find_node_scripts_dir(&app)
        .map(|d| d.to_string_lossy().into_owned());

    // Determine the provider and look up any stored API key.
    // Azure stores the key under "azure_api_key" to separate it from
    // the endpoint and deployment entries in the same store.
    let provider = provider_for_model(&model);
    let key_store_name = if provider == "azure" { "azure_api_key" } else { provider };
    let api_key  = read_api_key_from_store(&app, key_store_name);

    // For Azure, also read the endpoint and deployment from the store.
    let azure_endpoint   = if provider == "azure" { read_api_key_from_store(&app, "azure_endpoint")   } else { None };
    let azure_deployment = if provider == "azure" { read_api_key_from_store(&app, "azure_deployment") } else { None };

    args.extend([
        "--project".to_string(),
        project_dir,
        "--type".to_string(),
        "mr".to_string(),
        "--model".to_string(),
        model,
        "--provider".to_string(),
        provider.to_string(),
    ]);

    // Only pass --api-key when we actually have a stored key; otherwise the
    // Node script will fall back to process.env / the .env file.
    if let Some(ref key) = api_key {
        args.extend(["--api-key".to_string(), key.clone()]);
    }

    // Pass Azure-specific config when available.
    if let Some(ref ep) = azure_endpoint {
        args.extend(["--azure-endpoint".to_string(), ep.clone()]);
    }
    if let Some(ref dep) = azure_deployment {
        args.extend(["--azure-deployment".to_string(), dep.clone()]);
    }

    let total: u32 = if let Some(n) = section {
        args.extend(["--section".to_string(), n.to_string()]);
        1
    } else {
        args.push("--all".to_string());
        15
    };

    let mut cmd = app.shell().command(&node_cmd).args(&args);
    if let Some(root) = resource_root {
        cmd = cmd.env("AGCENSUS_RESOURCE_ROOT", root);
    }
    let (mut rx, _child) = cmd
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
    let (node_cmd, mut args) = resolve_invocation(&app, "generate.ts")?;
    let resource_root = find_node_scripts_dir(&app).map(|d| d.to_string_lossy().into_owned());

    let provider = provider_for_model(&model);
    let key_store_name = if provider == "azure" { "azure_api_key" } else { provider };
    let api_key  = read_api_key_from_store(&app, key_store_name);

    let azure_endpoint   = if provider == "azure" { read_api_key_from_store(&app, "azure_endpoint")   } else { None };
    let azure_deployment = if provider == "azure" { read_api_key_from_store(&app, "azure_deployment") } else { None };

    args.extend([
        "--project".to_string(),
        project_dir,
        "--type".to_string(),
        "tmr".to_string(),
        "--model".to_string(),
        model,
        "--provider".to_string(),
        provider.to_string(),
    ]);

    if let Some(ref key) = api_key {
        args.extend(["--api-key".to_string(), key.clone()]);
    }

    if let Some(ref ep) = azure_endpoint {
        args.extend(["--azure-endpoint".to_string(), ep.clone()]);
    }
    if let Some(ref dep) = azure_deployment {
        args.extend(["--azure-deployment".to_string(), dep.clone()]);
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

    let mut cmd = app.shell().command(&node_cmd).args(&args);
    if let Some(root) = resource_root {
        cmd = cmd.env("AGCENSUS_RESOURCE_ROOT", root);
    }
    let (mut rx, _child) = cmd
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
    let (node_cmd, mut args) = resolve_invocation(&app, "export.mjs")?;
    args.extend(["--project".to_string(), project_dir, "--type".to_string(), export_type]);

    let (mut rx, _child) = app
        .shell()
        .command(&node_cmd)
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
// Timestamp helper (no external crates required)
// ---------------------------------------------------------------------------

fn now_iso8601() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let mut s = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let sec  = s % 60; s /= 60;
    let min  = s % 60; s /= 60;
    let hour = s % 24; s /= 24;

    let mut year = 1970u32;
    loop {
        let dy: u64 = if year % 400 == 0 || (year % 4 == 0 && year % 100 != 0) { 366 } else { 365 };
        if s < dy { break; }
        s -= dy;
        year += 1;
    }
    let leap = year % 400 == 0 || (year % 4 == 0 && year % 100 != 0);
    const DOM: [u8; 12] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut month = 0usize;
    loop {
        let dm: u64 = if month == 1 && leap { 29 } else { DOM[month] as u64 };
        if s < dm { break; }
        s -= dm;
        if month == 11 { break; }
        month += 1;
    }
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", year, month + 1, s + 1, hour, min, sec)
}

/// Append a "reset" event to today's audit JSONL file for the given project.
fn append_audit_reset(project_dir: &str, target: &str, key: &str) {
    use std::io::Write;
    let timestamp = now_iso8601();
    let date = timestamp[..10].to_string(); // "YYYY-MM-DD"
    let audit_dir = std::path::Path::new(project_dir).join("audit");
    let _ = std::fs::create_dir_all(&audit_dir);
    let audit_path = audit_dir.join(format!("{date}-events.jsonl"));
    let event = serde_json::json!({
        "type": "reset",
        "timestamp": timestamp,
        "target": target,
        "section_or_table": key,
    });
    let line = format!("{}\n", event);
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&audit_path)
    {
        let _ = file.write_all(line.as_bytes());
    }
}

// ---------------------------------------------------------------------------
// Reset MR section command
// ---------------------------------------------------------------------------

/// Remove one MR section's generated content from `drafts/mr/_claims.json`,
/// reverting it to the "not generated" state without affecting other sections.
#[tauri::command]
fn reset_mr_section(project_dir: String, section_number: u32) -> Result<(), String> {
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
    if let Some(obj) = all_claims.as_object_mut() {
        obj.remove(&key);
    }

    let updated = serde_json::to_string_pretty(&all_claims)
        .map_err(|e| format!("Failed to serialize _claims.json: {e}"))?;

    fs::write(&claims_path, updated.as_bytes())
        .map_err(|e| format!("Failed to write _claims.json: {e}"))?;

    append_audit_reset(&project_dir, "mr", &key);
    Ok(())
}

// ---------------------------------------------------------------------------
// Reset TMR sub-table command
// ---------------------------------------------------------------------------

/// Remove one TMR sub-table's generated content from `drafts/tmr/_cells.json`,
/// reverting it to the "not generated" state without affecting other sub-tables.
#[tauri::command]
fn reset_tmr_subtable(project_dir: String, sub_table_number: u32) -> Result<(), String> {
    use std::fs;
    use std::path::Path;

    let cells_path = Path::new(&project_dir)
        .join("drafts")
        .join("tmr")
        .join("_cells.json");

    let raw = fs::read_to_string(&cells_path)
        .map_err(|e| format!("Failed to read _cells.json: {e}"))?;

    let mut all_cells: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| format!("Failed to parse _cells.json: {e}"))?;

    let key = format!("sub_table_{sub_table_number}");
    if let Some(obj) = all_cells.as_object_mut() {
        obj.remove(&key);
    }

    let updated = serde_json::to_string_pretty(&all_cells)
        .map_err(|e| format!("Failed to serialize _cells.json: {e}"))?;

    fs::write(&cells_path, updated.as_bytes())
        .map_err(|e| format!("Failed to write _cells.json: {e}"))?;

    append_audit_reset(&project_dir, "tmr", &key);
    Ok(())
}

// ---------------------------------------------------------------------------
// Reset ALL MR sections command
// ---------------------------------------------------------------------------

/// Clear the entire `drafts/mr/_claims.json` to `{}`, reverting all sections
/// to the "not generated" state.  A single audit event is appended.
#[tauri::command]
fn reset_all_mr(project_dir: String) -> Result<(), String> {
    use std::fs;
    use std::path::Path;

    let claims_path = Path::new(&project_dir)
        .join("drafts")
        .join("mr")
        .join("_claims.json");

    fs::write(&claims_path, b"{}")
        .map_err(|e| format!("Failed to write _claims.json: {e}"))?;

    append_audit_reset(&project_dir, "mr", "all");
    Ok(())
}

// ---------------------------------------------------------------------------
// Reset ALL TMR sub-tables command
// ---------------------------------------------------------------------------

/// Clear the entire `drafts/tmr/_cells.json` to `{}`, reverting all sub-tables
/// to the "not generated" state.  A single audit event is appended.
#[tauri::command]
fn reset_all_tmr(project_dir: String) -> Result<(), String> {
    use std::fs;
    use std::path::Path;

    let cells_path = Path::new(&project_dir)
        .join("drafts")
        .join("tmr")
        .join("_cells.json");

    fs::write(&cells_path, b"{}")
        .map_err(|e| format!("Failed to write _cells.json: {e}"))?;

    append_audit_reset(&project_dir, "tmr", "all");
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
// Copy source file command
// ---------------------------------------------------------------------------

/// Copy a PDF from an arbitrary location into `<project_dir>/sources/`.
///
/// Returns the absolute path of the copied file.
#[tauri::command]
fn copy_source_file(
    src_path: String,
    project_dir: String,
    doc_id: String,
    filename: String,
) -> Result<String, String> {
    use std::fs;
    use std::path::Path;

    let sources_dir = Path::new(&project_dir).join("sources");
    fs::create_dir_all(&sources_dir)
        .map_err(|e| format!("Failed to create sources directory: {e}"))?;

    let dest = sources_dir.join(format!("{doc_id}-{filename}"));
    fs::copy(&src_path, &dest)
        .map_err(|e| format!("Failed to copy file: {e}"))?;

    Ok(dest.to_string_lossy().into_owned())
}

// ---------------------------------------------------------------------------
// Ingest source command
// ---------------------------------------------------------------------------

/// Run the ingest pipeline for one PDF source document.
///
/// Spawns the ingest sidecar and streams progress events ("ingest-progress")
/// back to the frontend.
#[tauri::command]
async fn ingest_source(
    app: tauri::AppHandle,
    project_dir: String,
    doc_id: String,
    file_path: String,
    language: String,
) -> Result<(), String> {
    let (node_cmd, mut args) = resolve_invocation(&app, "ingest.mjs")?;
    args.extend([
        "--project".to_string(), project_dir,
        "--doc-id".to_string(),  doc_id.clone(),
        "--file".to_string(),    file_path,
        "--language".to_string(), language,
    ]);

    let resource_root = find_node_scripts_dir(&app).map(|d| d.to_string_lossy().into_owned());
    let mut cmd = app.shell().command(&node_cmd).args(&args);
    if let Some(root) = resource_root {
        cmd = cmd.env("AGCENSUS_RESOURCE_ROOT", root);
    }
    let (mut rx, _child) = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn ingest process: {e}"))?;

    let mut buf = String::new();
    let mut stderr_buf = String::new();
    let mut progress_emitted = false;

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                buf.push_str(&String::from_utf8_lossy(&bytes));
                while let Some(pos) = buf.find('\n') {
                    let line = buf[..pos].trim_end_matches('\r').to_string();
                    buf = buf[pos + 1..].to_string();

                    if let Some(rest) = line.strip_prefix("DONE:") {
                        progress_emitted = true;
                        let page_count = rest.trim().parse::<u32>().ok();
                        let _ = app.emit(
                            "ingest-progress",
                            IngestProgressPayload {
                                doc_id: doc_id.clone(),
                                status: "done".to_string(),
                                page_count,
                                message: None,
                            },
                        );
                    } else if let Some(rest) = line.strip_prefix("ERROR:") {
                        progress_emitted = true;
                        let _ = app.emit(
                            "ingest-progress",
                            IngestProgressPayload {
                                doc_id: doc_id.clone(),
                                status: "error".to_string(),
                                page_count: None,
                                message: Some(rest.trim().to_string()),
                            },
                        );
                    }
                }
            }
            CommandEvent::Stderr(bytes) => {
                stderr_buf.push_str(&String::from_utf8_lossy(&bytes));
            }
            CommandEvent::Terminated(_) | CommandEvent::Error(_) => break,
            _ => {}
        }
    }

    // Surface the real error when the process exits without printing DONE:/ERROR:.
    if !progress_emitted {
        let msg = if stderr_buf.trim().is_empty() {
            "Ingest process exited without output".to_string()
        } else {
            stderr_buf.trim().chars().take(800).collect()
        };
        let _ = app.emit(
            "ingest-progress",
            IngestProgressPayload {
                doc_id,
                status: "error".to_string(),
                page_count: None,
                message: Some(msg),
            },
        );
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// API connection test command
// ---------------------------------------------------------------------------

/// Test an API key by making a minimal real call via the Node.js sidecar.
///
/// Returns the round-trip latency in milliseconds as a string on success,
/// or a descriptive error message on failure.  Routing through the sidecar
/// avoids browser CORS restrictions that block direct calls from the webview.
#[tauri::command]
async fn test_api_connection_cmd(
    app: tauri::AppHandle,
    provider: String,
    api_key: String,
) -> Result<String, String> {
    let (node_cmd, mut args) = resolve_invocation(&app, "test-connection.mjs")?;
    args.extend(["--provider".to_string(), provider, "--api-key".to_string(), api_key]);

    let (mut rx, _child) = app
        .shell()
        .command(&node_cmd)
        .args(&args)
        .spawn()
        .map_err(|e| format!("Failed to spawn test-connection: {e}"))?;

    let mut buf = String::new();
    let mut output_val = String::new();
    let mut error_msg  = String::new();

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                buf.push_str(&String::from_utf8_lossy(&bytes));
                while let Some(pos) = buf.find('\n') {
                    let line = buf[..pos].trim_end_matches('\r').to_string();
                    buf = buf[pos + 1..].to_string();
                    if let Some(rest) = line.strip_prefix("DONE:") {
                        output_val = rest.trim().to_string();
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
    } else if !output_val.is_empty() {
        Ok(output_val)
    } else {
        Err("Connection test completed with no output".to_string())
    }
}

// ---------------------------------------------------------------------------
// Node.js availability check
// ---------------------------------------------------------------------------

/// Verify Node.js is installed and return its version string.
///
/// Called on app startup to show a helpful error before the project list
/// if Node is missing (generation and ingest both require Node at runtime).
#[tauri::command]
fn check_node_available() -> Result<String, String> {
    let node = find_node_binary().ok_or_else(|| {
        "Node.js is not installed or not on PATH. \
         Please install Node.js (LTS) from nodejs.org, then restart this application."
            .to_string()
    })?;
    let out = std::process::Command::new(&node)
        .arg("--version")
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(format!("node --version failed (exit {:?})", out.status.code()))
    }
}

// ---------------------------------------------------------------------------
// Ensure base dir command
// ---------------------------------------------------------------------------

/// Create the AgCensus base directory (and any missing parents) if it does
/// not yet exist.  Returns Ok(()) whether or not the directory already existed.
#[tauri::command]
fn ensure_base_dir(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())
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
// Delete source command
// ---------------------------------------------------------------------------

/// Delete one indexed source document and all its derived evidence.
///
/// Removes:
///   - evidence/pages/<doc_id>-*.json
///   - evidence/tables/<doc_id>-*.json
///   - sources/<doc_id>-* (the physical file)
///   - the entry from sources/_index.json
///   - all page/table entries from evidence/_evidence.json where source_doc == doc_id
///   - the entry from manifest.json source_documents where id == doc_id
#[tauri::command]
fn delete_source(project_dir: String, doc_id: String) -> Result<(), String> {
    use std::fs;
    use std::path::Path;

    let base = Path::new(&project_dir);

    // Helper: delete files in a directory whose names start with "<doc_id>-"
    fn delete_prefixed(dir: &Path, prefix: &str) -> Result<(), String> {
        if !dir.exists() { return Ok(()); }
        let entries = fs::read_dir(dir)
            .map_err(|e| format!("Failed to read {}: {e}", dir.display()))?;
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with(prefix) && name.ends_with(".json") {
                fs::remove_file(entry.path())
                    .map_err(|e| format!("Failed to remove {}: {e}", entry.path().display()))?;
            }
        }
        Ok(())
    }

    let prefix = format!("{doc_id}-");

    delete_prefixed(&base.join("evidence").join("pages"), &prefix)?;
    delete_prefixed(&base.join("evidence").join("tables"), &prefix)?;

    // Delete the physical source file (may have any extension after the prefix)
    let sources_dir = base.join("sources");
    if sources_dir.exists() {
        let entries = fs::read_dir(&sources_dir)
            .map_err(|e| format!("Failed to read sources dir: {e}"))?;
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name != "_index.json" && name.starts_with(&prefix) {
                fs::remove_file(entry.path())
                    .map_err(|e| format!("Failed to remove source file: {e}"))?;
            }
        }
    }

    // Update sources/_index.json
    let index_path = sources_dir.join("_index.json");
    if index_path.exists() {
        let raw = fs::read_to_string(&index_path)
            .map_err(|e| format!("Failed to read _index.json: {e}"))?;
        let mut index: serde_json::Value = serde_json::from_str(&raw)
            .map_err(|e| format!("Failed to parse _index.json: {e}"))?;
        if let Some(arr) = index.as_array_mut() {
            arr.retain(|entry| {
                entry.get("id").and_then(|v| v.as_str()) != Some(doc_id.as_str())
            });
        }
        let updated = serde_json::to_string_pretty(&index)
            .map_err(|e| format!("Failed to serialize _index.json: {e}"))?;
        fs::write(&index_path, updated.as_bytes())
            .map_err(|e| format!("Failed to write _index.json: {e}"))?;
    }

    // Update evidence/_evidence.json
    let evidence_path = base.join("evidence").join("_evidence.json");
    if evidence_path.exists() {
        let raw = fs::read_to_string(&evidence_path)
            .map_err(|e| format!("Failed to read _evidence.json: {e}"))?;
        let mut evidence: serde_json::Value = serde_json::from_str(&raw)
            .map_err(|e| format!("Failed to parse _evidence.json: {e}"))?;
        if let Some(obj) = evidence.as_object_mut() {
            for key in &["pages", "tables"] {
                if let Some(arr) = obj.get_mut(*key).and_then(|v| v.as_array_mut()) {
                    arr.retain(|entry| {
                        entry.get("source_doc").and_then(|v| v.as_str()) != Some(doc_id.as_str())
                    });
                }
            }
        }
        let updated = serde_json::to_string_pretty(&evidence)
            .map_err(|e| format!("Failed to serialize _evidence.json: {e}"))?;
        fs::write(&evidence_path, updated.as_bytes())
            .map_err(|e| format!("Failed to write _evidence.json: {e}"))?;
    }

    // Update manifest.json
    let manifest_path = base.join("manifest.json");
    if manifest_path.exists() {
        let raw = fs::read_to_string(&manifest_path)
            .map_err(|e| format!("Failed to read manifest.json: {e}"))?;
        let mut manifest: serde_json::Value = serde_json::from_str(&raw)
            .map_err(|e| format!("Failed to parse manifest.json: {e}"))?;
        if let Some(docs) = manifest
            .get_mut("source_documents")
            .and_then(|v| v.as_array_mut())
        {
            docs.retain(|entry| {
                entry.get("id").and_then(|v| v.as_str()) != Some(doc_id.as_str())
            });
        }
        let updated = serde_json::to_string_pretty(&manifest)
            .map_err(|e| format!("Failed to serialize manifest.json: {e}"))?;
        fs::write(&manifest_path, updated.as_bytes())
            .map_err(|e| format!("Failed to write manifest.json: {e}"))?;
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Bundle helpers
// ---------------------------------------------------------------------------

/// Walk `dir` recursively, appending every regular file path to `result`.
fn collect_files_recursive(
    dir: &std::path::Path,
    result: &mut Vec<std::path::PathBuf>,
) -> Result<(), String> {
    let entries = std::fs::read_dir(dir)
        .map_err(|e| format!("Cannot read '{}': {e}", dir.display()))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_files_recursive(&path, result)?;
        } else {
            result.push(path);
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Export bundle command
// ---------------------------------------------------------------------------

/// Zip the entire project directory into a single portable bundle file.
///
/// The archive stores entries as `<project-folder-name>/<relative-path>` so
/// that importing recreates the project folder cleanly inside any base dir.
/// Returns `Ok(dest_path)` on success.
#[tauri::command]
fn export_bundle(project_dir: String, dest_path: String) -> Result<String, String> {
    use std::fs;
    use std::io::{Read, Write};
    use std::path::Path;
    use zip::write::SimpleFileOptions;
    use zip::CompressionMethod;

    let project_path = Path::new(&project_dir);

    // The project folder name becomes the top-level directory inside the zip.
    let project_name = project_path
        .file_name()
        .ok_or_else(|| "Invalid project path — has no folder name".to_string())?
        .to_string_lossy()
        .into_owned();

    // Collect every file under the project directory.
    let mut files: Vec<std::path::PathBuf> = Vec::new();
    collect_files_recursive(project_path, &mut files)?;

    let dest_file = fs::File::create(&dest_path)
        .map_err(|e| format!("Failed to create '{dest_path}': {e}"))?;

    let mut zip = zip::ZipWriter::new(dest_file);
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated);

    for file_path in &files {
        // Path relative to the project directory root.
        let rel = file_path
            .strip_prefix(project_path)
            .map_err(|e| format!("Path strip error: {e}"))?;

        // Entry name: "<project_name>/<relative>"  (forward slashes in zip)
        let entry_name = format!(
            "{}/{}",
            project_name,
            rel.to_string_lossy().replace('\\', "/")
        );

        zip.start_file(&entry_name, options)
            .map_err(|e| format!("Failed to add '{entry_name}' to zip: {e}"))?;

        let mut f = fs::File::open(file_path)
            .map_err(|e| format!("Failed to open '{}': {e}", file_path.display()))?;
        let mut buf = Vec::new();
        f.read_to_end(&mut buf)
            .map_err(|e| format!("Failed to read '{}': {e}", file_path.display()))?;
        zip.write_all(&buf)
            .map_err(|e| format!("Failed to write to zip: {e}"))?;
    }

    zip.finish()
        .map_err(|e| format!("Failed to finalise zip: {e}"))?;

    Ok(dest_path)
}

// ---------------------------------------------------------------------------
// Import bundle command
// ---------------------------------------------------------------------------

/// Extract a project bundle zip into the AgCensus base directory.
///
/// Returns `Ok(project_folder_name)` on success.
/// Returns `Err("EXISTS:<name>")` when the destination already exists and
/// `overwrite` is false — the caller should prompt before retrying with
/// `overwrite: true`.
#[tauri::command]
fn import_bundle(
    bundle_path: String,
    base_dir: String,
    overwrite: bool,
) -> Result<String, String> {
    use std::fs;
    use std::io::Read;
    use std::path::Path;

    let f = fs::File::open(&bundle_path)
        .map_err(|e| format!("Failed to open bundle: {e}"))?;
    let mut archive = zip::ZipArchive::new(f)
        .map_err(|e| format!("Not a valid ZIP file: {e}"))?;

    if archive.len() == 0 {
        return Err("Bundle is empty".to_string());
    }

    // Pass 1: collect all entry names (ZipFile borrow drops at each iteration).
    let mut entry_names: Vec<String> = Vec::new();
    for i in 0..archive.len() {
        let file = archive
            .by_index(i)
            .map_err(|e| format!("Failed to read zip entry {i}: {e}"))?;
        entry_names.push(file.name().to_string());
    }

    // Derive the project folder name from the first entry's top-level component.
    let project_folder_name = {
        let first = entry_names
            .first()
            .ok_or_else(|| "Bundle has no entries".to_string())?;
        let top = first.split('/').next().unwrap_or("").trim().to_string();
        if top.is_empty() {
            return Err("Bundle has no top-level project directory".to_string());
        }
        top
    };

    // Validate: manifest.json must be present inside the bundle.
    let manifest_entry = format!("{}/manifest.json", project_folder_name);
    if !entry_names.iter().any(|n| n == &manifest_entry) {
        return Err(
            "Not a valid Ag Census project bundle — manifest.json not found".to_string(),
        );
    }

    // Check whether the destination directory already exists.
    let dest_dir = Path::new(&base_dir).join(&project_folder_name);
    if dest_dir.exists() {
        if !overwrite {
            return Err(format!("EXISTS:{project_folder_name}"));
        }
        fs::remove_dir_all(&dest_dir)
            .map_err(|e| format!("Failed to remove existing project: {e}"))?;
    }

    // Pass 2: extract all entries into base_dir.
    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| format!("Failed to read zip entry {i}: {e}"))?;

        let raw_name = file.name().replace('\\', "/");

        // Reject path traversal attempts.
        if raw_name.contains("..") {
            return Err(format!(
                "Security: rejected path traversal in entry '{raw_name}'"
            ));
        }

        let out_path = Path::new(&base_dir).join(&raw_name);

        if raw_name.ends_with('/') {
            fs::create_dir_all(&out_path)
                .map_err(|e| format!("Failed to create directory: {e}"))?;
        } else {
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create parent directory: {e}"))?;
            }
            let mut buf = Vec::new();
            file.read_to_end(&mut buf)
                .map_err(|e| format!("Failed to read zip entry: {e}"))?;
            fs::write(&out_path, &buf)
                .map_err(|e| format!("Failed to write '{}': {e}", out_path.display()))?;
        }
    }

    // Validate the extracted manifest parses as JSON (detect corrupt bundles).
    let manifest_path = dest_dir.join("manifest.json");
    let manifest_content = fs::read_to_string(&manifest_path).map_err(|e| {
        let _ = fs::remove_dir_all(&dest_dir);
        format!("Failed to read extracted manifest.json: {e}")
    })?;
    serde_json::from_str::<serde_json::Value>(&manifest_content).map_err(|e| {
        let _ = fs::remove_dir_all(&dest_dir);
        format!("Bundle is corrupt — manifest.json is not valid JSON: {e}")
    })?;

    Ok(project_folder_name)
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
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            generate_mr_sections,
            generate_tmr_subtable,
            ensure_base_dir,
            create_project,
            export_project,
            export_bundle,
            import_bundle,
            save_mr_section,
            approve_mr_section,
            reset_mr_section,
            reset_tmr_subtable,
            reset_all_mr,
            reset_all_tmr,
            open_path,
            save_api_key,
            get_api_key,
            copy_source_file,
            ingest_source,
            delete_source,
            test_api_connection_cmd,
            check_node_available,
        ])
        .run(tauri::generate_context!())
        .expect("error while running AgCensus Compiler");
}
