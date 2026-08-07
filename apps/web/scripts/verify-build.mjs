import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = new URL("..", import.meta.url);
const distDirectory = fileURLToPath(new URL("./dist/", projectRoot));
const requiredFiles = [
  "index.html",
  "manifest.webmanifest",
  "service-worker.js",
  "_headers",
];
const maximumBytes = { ".js": 650 * 1024, ".css": 180 * 1024 };

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(absolutePath)));
    else files.push(absolutePath);
  }
  return files;
}

const files = await walk(distDirectory);
const relativeFiles = files.map((file) => relative(distDirectory, file));

for (const requiredFile of requiredFiles) {
  if (!relativeFiles.includes(requiredFile))
    throw new Error(`Production build is missing ${requiredFile}.`);
}

if (relativeFiles.some((file) => file.endsWith(".map"))) {
  throw new Error("Public production output contains source maps.");
}

for (const [extension, budget] of Object.entries(maximumBytes)) {
  const matchingFiles = files.filter(
    (file) => extname(file) === extension && file.includes("/assets/"),
  );
  const total = (
    await Promise.all(
      matchingFiles.map(async (file) => (await stat(file)).size),
    )
  ).reduce((sum, size) => sum + size, 0);
  if (total > budget) {
    throw new Error(
      `${extension} assets exceed the ${String(Math.round(budget / 1024))} KiB baseline budget.`,
    );
  }
}

const indexHtml = await readFile(
  new URL("./dist/index.html", projectRoot),
  "utf8",
);
if (/<script(?![^>]*\bintegrity=)[^>]*\bsrc="\/assets\//u.test(indexHtml)) {
  throw new Error("A production script is missing subresource integrity.");
}
if (/<link(?![^>]*\bintegrity=)[^>]*\bhref="\/assets\//u.test(indexHtml)) {
  throw new Error("A production stylesheet is missing subresource integrity.");
}

const integrity = {};
for (const file of files.filter((candidate) =>
  candidate.includes("/assets/"),
)) {
  const contents = await readFile(file);
  integrity[`/${relative(distDirectory, file)}`] =
    `sha384-${createHash("sha384").update(contents).digest("base64")}`;
}

await writeFile(
  new URL("./dist/asset-integrity.json", projectRoot),
  `${JSON.stringify({ algorithm: "sha384", assets: integrity }, null, 2)}\n`,
  { mode: 0o644 },
);
