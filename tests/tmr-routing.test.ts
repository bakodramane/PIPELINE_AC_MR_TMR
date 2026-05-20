/**
 * Offline smoke test for TMR routing — makes no API calls.
 *
 * Verifies:
 *   1. wca-2020.json has entries for sub-tables 1 through 23.
 *   2. SUBTABLE_KEYWORDS (exported from tmr.ts) has non-empty entries for
 *      sub-tables 1 through 23.
 *   3. MULTI_ROW_SUBTABLES (exported from tmr.ts) includes the expected set:
 *      {4, 5, 7, 9, 13, 22, 23}.
 *   4. Calling generateSubTable with an out-of-range sub-table number (99)
 *      returns gracefully (undefined) without throwing.
 *
 * No DeepSeek/Kimi API key is required — the out-of-range guard fires before
 * any evidence retrieval or model call.
 */

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import {
  generateSubTable,
  SUBTABLE_KEYWORDS,
  MULTI_ROW_SUBTABLES,
} from "../src/generators/tmr";

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to wca-2020.json at the project root. */
const WCA_JSON = path.resolve(
  __dirname,
  "..",
  "src",
  "concepts",
  "wca-2020.json",
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TMR routing — offline smoke test", () => {
  it("wca-2020.json has entries for sub-tables 1 through 23", async () => {
    const raw = await readFile(WCA_JSON, "utf-8");
    const concepts = JSON.parse(raw) as {
      sub_tables: Record<string, unknown>;
    };

    for (let n = 1; n <= 23; n++) {
      expect(
        concepts.sub_tables[String(n)],
        `wca-2020.json is missing entry for sub_table ${n}`,
      ).toBeDefined();
    }
  });

  it("SUBTABLE_KEYWORDS has non-empty entries for sub-tables 1 through 23", () => {
    for (let n = 1; n <= 23; n++) {
      const kws = SUBTABLE_KEYWORDS[n];
      expect(
        kws,
        `SUBTABLE_KEYWORDS is missing entry for sub-table ${n}`,
      ).toBeDefined();
      expect(
        Array.isArray(kws),
        `SUBTABLE_KEYWORDS[${n}] is not an array`,
      ).toBe(true);
      expect(
        (kws ?? []).length,
        `SUBTABLE_KEYWORDS[${n}] is empty — at least one keyword is required`,
      ).toBeGreaterThan(0);
    }
  });

  it("MULTI_ROW_SUBTABLES includes exactly {4, 5, 7, 9, 13, 22, 23}", () => {
    const expected = [4, 5, 7, 9, 13, 22, 23];
    for (const n of expected) {
      expect(
        MULTI_ROW_SUBTABLES.has(n),
        `MULTI_ROW_SUBTABLES is missing sub-table ${n}`,
      ).toBe(true);
    }
    // Confirm no unexpected entries snuck in (within the 1–26 range)
    for (let n = 1; n <= 26; n++) {
      if (!expected.includes(n)) {
        expect(
          MULTI_ROW_SUBTABLES.has(n),
          `MULTI_ROW_SUBTABLES unexpectedly contains sub-table ${n}`,
        ).toBe(false);
      }
    }
  });

  it("generateSubTable(99) returns undefined without throwing", async () => {
    // Any path works because the function returns early before touching the
    // project directory when the sub-table spec is missing.
    const fakePath = path.join(os.tmpdir(), "agcensus-smoke-test-99");

    await expect(
      generateSubTable(fakePath, 99, "deepseek-v4-flash"),
    ).resolves.toBeUndefined();
  });
});
