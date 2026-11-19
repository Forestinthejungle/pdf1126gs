// Lists every .xlsx file in the repository into import-files.json, so the dashboard loads them as import files.
import { readdir, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const SKIP = new Set(['.git', 'node_modules']);

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(path));
    // "~$" files are Excel lock files, not data.
    else if (/\.xlsx$/i.test(entry.name) && !entry.name.startsWith('~$')) out.push(relative(root, path).split(sep).join('/'));
  }
  return out;
}

const files = (await walk(root)).sort((a, b) => a.localeCompare(b, 'pl'));
await writeFile(join(root, 'import-files.json'), `${JSON.stringify({ files }, null, 2)}\n`);
console.log(`import-files.json: ${files.length} file(s)`);
