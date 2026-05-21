/**
 * useProjects — React hook that loads country projects from the AgCensus
 * project base directory using @tauri-apps/plugin-fs.
 *
 * Reads:
 *   <baseDir>/<projectName>/manifest.json
 *   <baseDir>/<projectName>/drafts/mr/_claims.json
 *   <baseDir>/<projectName>/drafts/tmr/_cells.json
 *
 * All filesystem operations go through Tauri's sandboxed fs plugin so they
 * are subject to the scope set in src-tauri/capabilities/default.json.
 */

import { useState, useEffect, useCallback } from "react";
import { readDir, readTextFile, exists } from "@tauri-apps/plugin-fs";
import { homeDir } from "@tauri-apps/api/path";
import type { Manifest, ClaimsJson, CellsJson } from "../project/schema";
import {
  type ProjectInfo,
  MR_SECTIONS_TOTAL,
  TMR_SUBTABLES_TOTAL,
} from "../types/ui";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BASE_DIR_STORAGE_KEY = "agcensus_base_dir";

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Join path segments with forward slashes (Tauri handles OS normalisation). */
function joinPath(...parts: string[]): string {
  return parts
    .map((p) => p.replace(/[/\\]+$/, "")) // strip trailing separators
    .join("/");
}

// ---------------------------------------------------------------------------
// Project loader
// ---------------------------------------------------------------------------

async function resolveBaseDir(stored: string): Promise<string> {
  if (stored) return stored;
  // Default: ~/Documents/AgCensus
  const home = await homeDir();
  return joinPath(home.replace(/[/\\]+$/, ""), "Documents", "AgCensus");
}

async function computeMrStatus(
  projectDir: string,
): Promise<{ ok: number; total: number }> {
  const claimsPath = joinPath(projectDir, "drafts", "mr", "_claims.json");
  try {
    const raw = await readTextFile(claimsPath);
    const claims = JSON.parse(raw) as ClaimsJson;
    let ok = 0;
    for (let s = 1; s <= MR_SECTIONS_TOTAL; s++) {
      const section = claims[`section_${s}`];
      if (section && section.claims.length > 0) ok++;
    }
    return { ok, total: MR_SECTIONS_TOTAL };
  } catch {
    return { ok: 0, total: MR_SECTIONS_TOTAL };
  }
}

async function computeTmrStatus(
  projectDir: string,
): Promise<{ ok: number; total: number }> {
  const cellsPath = joinPath(projectDir, "drafts", "tmr", "_cells.json");
  try {
    const raw = await readTextFile(cellsPath);
    const cells = JSON.parse(raw) as CellsJson;
    let ok = 0;
    for (let t = 1; t <= TMR_SUBTABLES_TOTAL; t++) {
      const subTable = cells[`sub_table_${t}`];
      if (!subTable) continue;
      // Count as "ok" if at least one cell has a numeric value.
      // Cast through unknown because _cells.json also has validation_flags,
      // parse_failed, truncated keys that don't conform to the Cell schema type.
      const hasNumber = Object.values(subTable as Record<string, unknown>).some(
        (v): boolean => {
          if (v === null || typeof v !== "object") return false;
          return typeof (v as { value?: unknown }).value === "number";
        },
      );
      if (hasNumber) ok++;
    }
    return { ok, total: TMR_SUBTABLES_TOTAL };
  } catch {
    return { ok: 0, total: TMR_SUBTABLES_TOTAL };
  }
}

async function loadProject(
  projectDir: string,
): Promise<ProjectInfo | null> {
  const manifestPath = joinPath(projectDir, "manifest.json");
  const manifestExists = await exists(manifestPath);
  if (!manifestExists) return null;

  try {
    const manifestRaw = await readTextFile(manifestPath);
    const manifest = JSON.parse(manifestRaw) as Manifest;
    const [mr, tmr] = await Promise.all([
      computeMrStatus(projectDir),
      computeTmrStatus(projectDir),
    ]);
    return {
      dir: projectDir,
      manifest,
      mrSectionsOk: mr.ok,
      mrSectionsTotal: mr.total,
      tmrSubTablesOk: tmr.ok,
      tmrSubTablesTotal: tmr.total,
      lastModified: manifest.compiled_at,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseProjectsResult {
  projects: ProjectInfo[];
  loading: boolean;
  error: string | null;
  baseDir: string;
  setBaseDir: (dir: string) => void;
  refresh: () => void;
}

export function useProjects(): UseProjectsResult {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [baseDir, setBaseDirState] = useState<string>(
    () => localStorage.getItem(BASE_DIR_STORAGE_KEY) ?? "",
  );
  const [refreshNonce, setRefreshNonce] = useState(0);

  const setBaseDir = useCallback((dir: string) => {
    localStorage.setItem(BASE_DIR_STORAGE_KEY, dir);
    setBaseDirState(dir);
  }, []);

  const refresh = useCallback(() => {
    setRefreshNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      setLoading(true);
      setError(null);

      try {
        const resolvedBase = await resolveBaseDir(baseDir);
        if (!baseDir && resolvedBase) {
          setBaseDirState(resolvedBase);
        }

        // Check base dir exists
        const baseDirExists = await exists(resolvedBase);
        if (!baseDirExists) {
          if (!cancelled) {
            setProjects([]);
            setError(
              `Project directory not found: ${resolvedBase}\n` +
                "Create it and run the generator CLI scripts to populate it.",
            );
            setLoading(false);
          }
          return;
        }

        // List immediate subdirectories
        const entries = await readDir(resolvedBase);
        const results = await Promise.all(
          entries
            .filter((e) => e.isDirectory)
            .map((e) => loadProject(joinPath(resolvedBase, e.name))),
        );

        if (!cancelled) {
          setProjects(
            results.filter((p): p is ProjectInfo => p !== null),
          );
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(String(err));
          setLoading(false);
        }
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [baseDir, refreshNonce]);

  return { projects, loading, error, baseDir, setBaseDir, refresh };
}
