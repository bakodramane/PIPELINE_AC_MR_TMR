/**
 * On-disk project validator.
 *
 * validateProject() scans a project directory and returns a typed list of
 * issues.  An empty list means the project is structurally sound.  Callers
 * decide how to surface issues (UI badge, CLI exit code, etc.).
 *
 * All file access uses fs/promises.  All paths use path.join().
 */

import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type {
  Manifest,
  SourceIndex,
  SourceIndexEntry,
  EvidenceIndex,
  ClaimsJson,
  CellsJson,
} from "./schema";
import {
  manifestPath,
  sourceIndexPath,
  evidenceIndexPath,
  claimsPath,
  cellsPath,
} from "./io";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type IssueSeverity = "error" | "warning";

export interface ValidationIssue {
  severity: IssueSeverity;
  /**
   * Dot-separated path within the project, e.g.:
   *   "manifest.json"
   *   "manifest.country_iso3"
   *   "sources/_index.json[2].sha256"
   *   "evidence/_evidence.json"
   */
  path: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function safeReadJson<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function err(issuePath: string, message: string): ValidationIssue {
  return { severity: "error", path: issuePath, message };
}

function warn(issuePath: string, message: string): ValidationIssue {
  return { severity: "warning", path: issuePath, message };
}

// Required top-level string fields on Manifest
const MANIFEST_REQUIRED_FIELDS: (keyof Manifest)[] = [
  "schema_version",
  "country",
  "country_iso3",
  "census_round",
  "census_name",
  "reference_year",
  "reference_day",
  "methodology_type",
  "statistical_unit",
  "national_statistical_office",
  "compiled_by",
  "compiled_at",
  "app_version",
];

// Required fields on each SourceIndexEntry
const SOURCE_ENTRY_REQUIRED: (keyof SourceIndexEntry)[] = [
  "id",
  "filename",
  "url",
  "retrieved",
  "sha256",
  "language",
  "description",
];

// ---------------------------------------------------------------------------
// validateProject
// ---------------------------------------------------------------------------

/**
 * Validate a country project directory against the DESIGN.md §4 schema.
 * Returns [] for a clean project, or a list of issues otherwise.
 */
export async function validateProject(
  projectDir: string,
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];

  // -------------------------------------------------------------------------
  // §4.1  manifest.json
  // -------------------------------------------------------------------------

  const mPath = manifestPath(projectDir);
  if (!(await exists(mPath))) {
    issues.push(err("manifest.json", "File does not exist"));
    // Nothing more we can check without a manifest
    return issues;
  }

  const manifest = await safeReadJson<Manifest>(mPath);
  if (manifest === null) {
    issues.push(err("manifest.json", "File exists but is not valid JSON"));
    return issues;
  }

  if (manifest.schema_version !== "1.0") {
    issues.push(
      err(
        "manifest.schema_version",
        `Expected "1.0", got "${manifest.schema_version}"`,
      ),
    );
  }

  for (const field of MANIFEST_REQUIRED_FIELDS) {
    const val = manifest[field];
    if (val === undefined || val === null || val === "") {
      issues.push(
        err(`manifest.${field}`, `Required field is missing or empty`),
      );
    }
  }

  if (!Array.isArray(manifest.source_documents)) {
    issues.push(
      err("manifest.source_documents", "Must be an array"),
    );
  }

  // -------------------------------------------------------------------------
  // §4.2  sources/
  // -------------------------------------------------------------------------

  const sourcesDir = path.join(projectDir, "sources");
  if (!(await exists(sourcesDir))) {
    issues.push(err("sources/", "Directory does not exist"));
  } else {
    const siPath = sourceIndexPath(projectDir);
    if (!(await exists(siPath))) {
      issues.push(err("sources/_index.json", "File does not exist"));
    } else {
      const index = await safeReadJson<SourceIndex>(siPath);
      if (index === null) {
        issues.push(
          err("sources/_index.json", "File exists but is not valid JSON"),
        );
      } else if (!Array.isArray(index)) {
        issues.push(err("sources/_index.json", "Must be a JSON array"));
      } else {
        // Validate each entry
        for (let i = 0; i < index.length; i++) {
          const entry = index[i];
          for (const field of SOURCE_ENTRY_REQUIRED) {
            const val = entry[field];
            if (val === undefined || val === null || val === "") {
              issues.push(
                err(
                  `sources/_index.json[${i}].${field}`,
                  "Required field is missing or empty",
                ),
              );
            }
          }
        }

        // Cross-reference: every manifest.source_documents id should appear in index
        if (Array.isArray(manifest.source_documents)) {
          const indexIds = new Set(index.map((e) => e.id));
          for (const ref of manifest.source_documents) {
            if (!indexIds.has(ref.id)) {
              issues.push(
                warn(
                  `sources/_index.json`,
                  `Source "${ref.id}" appears in manifest.source_documents but has no entry in _index.json`,
                ),
              );
            }
          }

          // And vice-versa
          const manifestIds = new Set(
            manifest.source_documents.map((r) => r.id),
          );
          for (const entry of index) {
            if (!manifestIds.has(entry.id)) {
              issues.push(
                warn(
                  `manifest.source_documents`,
                  `Source "${entry.id}" appears in _index.json but is not listed in manifest.source_documents`,
                ),
              );
            }
          }
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // §4.3  evidence/
  // -------------------------------------------------------------------------

  const evidenceDir = path.join(projectDir, "evidence");
  if (!(await exists(evidenceDir))) {
    issues.push(err("evidence/", "Directory does not exist"));
  } else {
    const pagesDir = path.join(evidenceDir, "pages");
    if (!(await exists(pagesDir))) {
      issues.push(warn("evidence/pages/", "Directory does not exist"));
    }

    const tablesDir = path.join(evidenceDir, "tables");
    if (!(await exists(tablesDir))) {
      issues.push(warn("evidence/tables/", "Directory does not exist"));
    }

    const eiPath = evidenceIndexPath(projectDir);
    if (!(await exists(eiPath))) {
      issues.push(err("evidence/_evidence.json", "File does not exist"));
    } else {
      const evidenceIndex = await safeReadJson<EvidenceIndex>(eiPath);
      if (evidenceIndex === null) {
        issues.push(
          err(
            "evidence/_evidence.json",
            "File exists but is not valid JSON",
          ),
        );
      } else {
        if (!Array.isArray(evidenceIndex.pages)) {
          issues.push(
            err("evidence/_evidence.json.pages", "Must be an array"),
          );
        }
        if (!Array.isArray(evidenceIndex.tables)) {
          issues.push(
            err("evidence/_evidence.json.tables", "Must be an array"),
          );
        }
        if (!evidenceIndex.last_updated) {
          issues.push(
            warn(
              "evidence/_evidence.json.last_updated",
              "Missing last_updated timestamp",
            ),
          );
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // §4.4  drafts/
  // -------------------------------------------------------------------------

  const draftsDir = path.join(projectDir, "drafts");
  if (!(await exists(draftsDir))) {
    issues.push(err("drafts/", "Directory does not exist"));
  } else {
    // MR
    const mrDir = path.join(draftsDir, "mr");
    if (!(await exists(mrDir))) {
      issues.push(err("drafts/mr/", "Directory does not exist"));
    } else {
      const cPath = claimsPath(projectDir);
      if (!(await exists(cPath))) {
        issues.push(
          err("drafts/mr/_claims.json", "File does not exist"),
        );
      } else {
        const claims = await safeReadJson<ClaimsJson>(cPath);
        if (claims === null) {
          issues.push(
            err(
              "drafts/mr/_claims.json",
              "File exists but is not valid JSON",
            ),
          );
        } else if (
          typeof claims !== "object" ||
          Array.isArray(claims)
        ) {
          issues.push(
            err("drafts/mr/_claims.json", "Must be a JSON object"),
          );
        }
      }
    }

    // TMR
    const tmrDir = path.join(draftsDir, "tmr");
    if (!(await exists(tmrDir))) {
      issues.push(err("drafts/tmr/", "Directory does not exist"));
    } else {
      const cPath = cellsPath(projectDir);
      if (!(await exists(cPath))) {
        issues.push(
          err("drafts/tmr/_cells.json", "File does not exist"),
        );
      } else {
        const cells = await safeReadJson<CellsJson>(cPath);
        if (cells === null) {
          issues.push(
            err(
              "drafts/tmr/_cells.json",
              "File exists but is not valid JSON",
            ),
          );
        } else if (typeof cells !== "object" || Array.isArray(cells)) {
          issues.push(
            err("drafts/tmr/_cells.json", "Must be a JSON object"),
          );
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // §4.5  audit/
  // -------------------------------------------------------------------------

  const auditDir = path.join(projectDir, "audit");
  if (!(await exists(auditDir))) {
    issues.push(err("audit/", "Directory does not exist"));
  } else {
    const entries = await readdir(auditDir);
    const jsonlFiles = entries.filter((f) => f.endsWith(".jsonl"));
    if (jsonlFiles.length === 0) {
      issues.push(
        warn("audit/", "No JSONL event files found — audit trail is empty"),
      );
    } else {
      // Spot-check each JSONL file: every non-blank line must be valid JSON
      for (const fname of jsonlFiles) {
        const fpath = path.join(auditDir, fname);
        const raw = await readFile(fpath, "utf-8");
        const lines = raw.split("\n").filter((l) => l.trim() !== "");
        for (let i = 0; i < lines.length; i++) {
          try {
            JSON.parse(lines[i]);
          } catch {
            issues.push(
              err(
                `audit/${fname}:${i + 1}`,
                "Line is not valid JSON",
              ),
            );
          }
        }
      }
    }
  }

  return issues;
}
