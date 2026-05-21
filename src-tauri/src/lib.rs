/// AgCensus Compiler — Tauri backend.
///
/// Session 12: adds tauri-plugin-fs (for project directory reads) and a
/// placeholder `generate_mr_sections` command.
/// Session 13: adds placeholder `generate_tmr_subtable` command.
/// Real wiring for both generation commands deferred to Session 14.

/// Placeholder MR generation command.
/// Returns Err so the frontend shows a warning toast pointing to the CLI.
#[tauri::command]
async fn generate_mr_sections(project_dir: String, model: String) -> Result<String, String> {
    // TODO Session 14: spawn the Node.js generator via sidecar or shell command.
    let _ = model; // suppress unused-variable warning until wired
    Err(format!(
        "UI-triggered generation is not yet wired.\n\
         Run the CLI script instead:\n\
           node \"{}/node_modules/vitest/vitest.mjs\" run \\\n\
             --config vitest.scripts.config.ts --reporter verbose\n\
         Project dir: {project_dir}",
        // Best-effort: strip trailing path component to find project root
        project_dir
            .rsplitn(4, ['/', '\\'])
            .last()
            .unwrap_or(&project_dir),
        project_dir = project_dir,
    ))
}

/// Placeholder TMR sub-table generation command.
///
/// sub_table_number == 0  → "generate all sub-tables" (called from the
///                          "Generate all sub-tables" button in TmrReview)
/// sub_table_number >= 1  → generate the specified sub-table only
///
/// Returns Ok so the frontend shows an info toast with the queued message.
/// TODO Session 14: spawn the Node.js tmr.ts generator via sidecar.
#[tauri::command]
async fn generate_tmr_subtable(
    project_dir: String,
    sub_table_number: i32,
    model: String,
) -> Result<String, String> {
    let _ = model; // suppress unused-variable warning until wired
    let _ = project_dir;
    if sub_table_number == 0 {
        Ok(
            "All TMR sub-tables queued — UI-triggered generation is coming in Session 14.\n\
             Run the CLI scripts to generate now."
                .to_string(),
        )
    } else {
        Ok(format!(
            "Sub-table {sub_table_number} queued — UI-triggered generation is coming in Session 14.\n\
             Run the CLI scripts to generate now."
        ))
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            generate_mr_sections,
            generate_tmr_subtable
        ])
        .run(tauri::generate_context!())
        .expect("error while running AgCensus Compiler");
}
