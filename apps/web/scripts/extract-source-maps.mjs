import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = new URL("..", import.meta.url);
const distDirectory = fileURLToPath(new URL("./dist/", projectRoot));
const privateDirectory = fileURLToPath(
  new URL("./private-source-maps/", projectRoot),
);

async function findSourceMaps(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const maps = [];
  for (const entry of entries) {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) maps.push(...(await findSourceMaps(absolutePath)));
    else if (entry.name.endsWith(".map")) maps.push(absolutePath);
  }
  return maps;
}

await rm(privateDirectory, { recursive: true, force: true });
await mkdir(privateDirectory, { recursive: true });

for (const sourceMap of await findSourceMaps(distDirectory)) {
  const safeName = relative(distDirectory, sourceMap).replaceAll("/", "__");
  await rename(
    sourceMap,
    join(privateDirectory, safeName || basename(sourceMap)),
  );
}
