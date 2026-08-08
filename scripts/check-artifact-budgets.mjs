#!/usr/bin/env node
/**
 * Master specification §17: alert on artifact-size regression.
 *
 * Budgets live in `budgets/artifact-budgets.json` with the measured baseline
 * and the command that produced it. This compares what is on disk now against
 * those ceilings.
 *
 * An artifact that has not been built is skipped rather than failing: a
 * developer running this after a Web build should not be told the Android
 * bundle is missing. What is *not* skipped is the whole run being empty — a
 * check that measured nothing must not report success, because that is
 * indistinguishable from a check that measured everything and found it fine.
 *
 * Pass --json for machine-readable output, and --require=<id,id> to insist that
 * particular artifacts were present, which is how CI turns "skipped" into a
 * failure for the artifacts that job actually built.
 */
import { globSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const budgets = JSON.parse(
  readFileSync(join(root, "budgets/artifact-budgets.json"), "utf8"),
);

const asJson = process.argv.includes("--json");
const requireArgument = process.argv.find((value) =>
  value.startsWith("--require="),
);
const required = new Set(
  requireArgument ? requireArgument.slice("--require=".length).split(",") : [],
);

/** Total bytes of a file, or of every file beneath a directory. */
function sizeOf(target) {
  const stats = statSync(target, { throwIfNoEntry: false });
  if (!stats) return null;
  if (stats.isFile()) return stats.size;
  let total = 0;
  for (const entry of globSync("**/*", { cwd: target, withFileTypes: true })) {
    if (entry.isFile())
      total += statSync(join(entry.parentPath, entry.name)).size;
  }
  return total;
}

const results = [];
for (const artifact of budgets.artifacts) {
  const patterns = artifact.paths ?? [artifact.path];
  let bytes = 0;
  let found = false;
  for (const pattern of patterns) {
    const matches = pattern.includes("*")
      ? globSync(pattern, { cwd: root }).map((match) => join(root, match))
      : [join(root, pattern)];
    for (const match of matches) {
      const size = sizeOf(match);
      if (size !== null) {
        bytes += size;
        found = true;
      }
    }
  }

  const ceiling = Math.round(
    artifact.baselineBytes * (1 + artifact.allowedGrowth),
  );
  results.push({
    id: artifact.id,
    label: artifact.label,
    found,
    bytes,
    baselineBytes: artifact.baselineBytes,
    ceilingBytes: ceiling,
    overBudget: found && bytes > ceiling,
  });
}

const missing = [...required].filter(
  (id) => !results.some((result) => result.id === id && result.found),
);
const over = results.filter((result) => result.overBudget);
const measured = results.filter((result) => result.found);

if (asJson) {
  console.log(JSON.stringify({ results, missing }, null, 2));
} else {
  const mb = (bytes) => `${(bytes / 1_048_576).toFixed(2)} MB`;
  for (const result of results) {
    if (!result.found) {
      console.log(`  skipped  ${result.label} (not built)`);
      continue;
    }
    const delta = result.bytes - result.baselineBytes;
    const sign = delta >= 0 ? "+" : "";
    const mark = result.overBudget ? "OVER    " : "ok      ";
    console.log(
      `  ${mark} ${result.label}: ${mb(result.bytes)} ` +
        `(${sign}${mb(delta)} vs baseline, ceiling ${mb(result.ceilingBytes)})`,
    );
  }
}

if (missing.length > 0) {
  console.error(`\nRequired artifacts were not built: ${missing.join(", ")}.`);
  process.exit(1);
}

if (over.length > 0) {
  console.error(
    "\nArtifacts exceeded their budget. Either find the growth, or raise the " +
      "ceiling in budgets/artifact-budgets.json with a reason in the commit " +
      "message. Never make room by removing a privacy or safety check.",
  );
  process.exit(1);
}

if (measured.length === 0 && required.size === 0) {
  console.log(
    "No artifacts were built, so nothing was checked. Build one and run again.",
  );
} else if (!asJson) {
  console.log(`\n${String(measured.length)} artifact(s) within budget.`);
}
