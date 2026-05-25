import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const roots = ["src"];
const extensions = new Set([".ts", ".js", ".mjs"]);
const alreadyRuntimeResolvable = /\.(?:c?js|mjs|json|node|css)$/;

function withJsExtension(specifier) {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return specifier;
  if (alreadyRuntimeResolvable.test(specifier)) return specifier;
  return `${specifier}.js`;
}

function patchImports(source) {
  return source
    .replace(/(\bfrom\s*["'])(\.{1,2}\/[^"']+)(["'])/g, (_match, prefix, specifier, suffix) => {
      return `${prefix}${withJsExtension(specifier)}${suffix}`;
    })
    .replace(/(\bimport\s*["'])(\.{1,2}\/[^"']+)(["'])/g, (_match, prefix, specifier, suffix) => {
      return `${prefix}${withJsExtension(specifier)}${suffix}`;
    })
    .replace(/(\bimport\s*\(\s*["'])(\.{1,2}\/[^"']+)(["']\s*\))/g, (_match, prefix, specifier, suffix) => {
      return `${prefix}${withJsExtension(specifier)}${suffix}`;
    });
}

async function walk(dir) {
  const entries = await readdir(dir);
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry);
      const info = await stat(path);
      if (info.isDirectory()) return walk(path);
      return extensions.has(path.slice(path.lastIndexOf("."))) ? [path] : [];
    }),
  );

  return files.flat();
}

let changed = 0;

for (const root of roots) {
  for (const file of await walk(root)) {
    const source = await readFile(file, "utf8");
    const patched = patchImports(source);
    if (patched !== source) {
      await writeFile(file, patched);
      changed += 1;
    }
  }
}

console.log(`Patched ESM import specifiers in ${changed} file${changed === 1 ? "" : "s"}.`);
