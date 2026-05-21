/// AgCensus Compiler — Tauri backend.
///
/// Session 12: adds tauri-plugin-fs (for project directory reads) and a
/// placeholder `generate_mr_sections` command (real wiring in Session 14).

#[tauri::command]
async fn generate_mr_sections(project_dir: String, model: String) -> Result<String, String> {
    // TODO Session 14: spawn the Node.js generator via sidecar or shell command.
    // For now, inform the user to use the CLI scripts.
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![generate_mr_sections])
        .run(tauri::generate_context!())
        .expect("error while running AgCensus Compiler");
}
