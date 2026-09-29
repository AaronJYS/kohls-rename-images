// Adds a deploy version to first-party module, worker, and stylesheet URLs.
// GitHub Pages lets browsers reuse files for 10 minutes without checking for
// updates. A reload refetches the page but not files requested after it loads,
// such as the Excel export module or the Hamrick's worker. Versioned URLs make
// every reload of a new deploy use that deploy's files.
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Quoted relative URLs in HTML attributes, static and dynamic imports, and
// new URL(...) worker references. Template expressions are never matched.
const ASSET_URL = /(["'`])(\.\.?\/[^"'`?#\s$]+\.(?:m?js|css))\1/g;

async function firstPartyFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    // Pinned third-party files do not change between deploys or import relative files.
    if (entry.isDirectory() && entry.name !== "vendor") files.push(...await firstPartyFiles(path));
    else if (entry.isFile() && /\.(?:html|m?js|css)$/.test(entry.name)) files.push(path);
  }
  return files;
}

export async function versionAssetURLs(root, version) {
  if (!/^[\w.-]+$/.test(version))
    throw new Error(`Version must contain only letters, digits, ".", "_", or "-": ${version}`);
  const pending = [];
  for (const file of await firstPartyFiles(root)) {
    const source = await readFile(file, "utf8");
    const urls = [...source.matchAll(ASSET_URL)].map((match) => match[2]);
    // Only rewrite strings that name files in this site, never other text.
    for (const url of urls) {
      const target = resolve(dirname(file), url), path = relative(resolve(root), target);
      if (isAbsolute(path) || path.startsWith("..") || !(await stat(target).catch(() => null))?.isFile())
        throw new Error(`${relative(root, file)} references ${url}, which is not a file in the site.`);
    }
    if (urls.length) pending.push({ file, source, count: urls.length });
  }
  // Every file is checked before any is changed.
  for (const { file, source } of pending)
    await writeFile(file, source.replace(ASSET_URL, (_, quote, url) => `${quote}${url}?v=${version}${quote}`));
  return { files: pending.length, references: pending.reduce((total, { count }) => total + count, 0) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [root, version] = process.argv.slice(2);
  if (!root || !version) {
    console.error("Usage: node scripts/version-asset-urls.mjs <site directory> <version>");
    process.exit(2);
  }
  const { files, references } = await versionAssetURLs(root, version);
  console.log(`Versioned ${references} asset URLs in ${files} files (v=${version}).`);
}
