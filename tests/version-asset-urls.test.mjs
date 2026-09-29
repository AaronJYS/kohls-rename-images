import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { versionAssetURLs } from "../scripts/version-asset-urls.mjs";

const web = fileURLToPath(new URL("../web/", import.meta.url));
// Any quoted relative module, worker, or stylesheet URL, with its version if present.
const ASSET_URL = /[`"']\.\.?\/[^`"'?#\s$]+\.(?:m?js|css)(\?v=[\w.-]+)?[`"']/g;

async function readTree(root, names) {
  return new Map(await Promise.all(names.map(async (name) => [name, await readFile(join(root, name))])));
}

test("deploy versioning covers every page, module, worker, and stylesheet URL, including ones loaded after the page", async () => {
  const root = await mkdtemp(join(tmpdir(), "versioned-site-"));
  try {
    await cp(web, root, { recursive: true });
    const names = (await readdir(root)).filter((name) => /\.(?:html|m?js|css)$/.test(name));
    const vendorNames = (await readdir(join(root, "vendor"), { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile()).map((entry) => relative(root, join(entry.parentPath, entry.name)));
    const before = await readTree(root, names), vendorBefore = await readTree(root, vendorNames);
    const counts = [...before.values()].map((source) => [...source.toString().matchAll(ASSET_URL)].length);

    assert.deepEqual(await versionAssetURLs(root, "abc123"), {
      files: counts.filter(Boolean).length,
      references: counts.reduce((total, count) => total + count, 0),
    });
    for (const name of names) {
      const source = await readFile(join(root, name), "utf8");
      assert.deepEqual([...source.matchAll(ASSET_URL)].filter((match) => match[1] !== "?v=abc123").map((match) => match[0]), [], name);
    }
    const file = (name) => readFile(join(root, name), "utf8");
    assert.match(await file("index.html"), /href="\.\/styles\.css\?v=abc123"/);
    assert.match(await file("index.html"), /src="\.\/pdf-app\.js\?v=abc123"/);
    // These load on demand, so a hard refresh alone does not refetch them.
    assert.match(await file("pdf-app.js"), /import\("\.\/excel-export\.js\?v=abc123"\)/);
    assert.match(await file("hamricks-file.js"), /new URL\("\.\/hamricks-worker\.js\?v=abc123", import\.meta\.url\)/);
    assert.match(await file("hamricks-worker.js"), /from "\.\/hamricks-reader\.js\?v=abc123"/);
    assert.match(await file("pdf-reader.js"), /import\("\.\/vendor\/pdfjs\/pdf\.min\.mjs\?v=abc123"\)/);
    assert.match(await file("pdf-reader.js"), /"\.\/vendor\/pdfjs\/pdf\.worker\.min\.mjs\?v=abc123"/);
    assert.deepEqual(await readTree(root, vendorNames), vendorBefore);

    const versioned = await readTree(root, names);
    assert.deepEqual(await versionAssetURLs(root, "def456"), { files: 0, references: 0 });
    assert.deepEqual(await readTree(root, names), versioned);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deploy versioning skips template expressions and vendor files and rejects strings that are not site files", async () => {
  const base = await mkdtemp(join(tmpdir(), "versioned-site-"));
  const root = join(base, "site");
  try {
    await mkdir(join(root, "vendor"), { recursive: true });
    await writeFile(join(root, "worker.js"), "");
    await writeFile(join(root, "vendor", "library.js"), 'import "./not-deployed.js";\n');
    await writeFile(join(root, "app.js"), "new URL(`./worker.js`, import.meta.url);\nconst tool = (name) => import(`./${name}.js`);\n");
    assert.deepEqual(await versionAssetURLs(root, "v1"), { files: 1, references: 1 });
    assert.equal(await readFile(join(root, "app.js"), "utf8"),
      "new URL(`./worker.js?v=v1`, import.meta.url);\nconst tool = (name) => import(`./${name}.js`);\n");
    assert.equal(await readFile(join(root, "vendor", "library.js"), "utf8"), 'import "./not-deployed.js";\n');

    for (const version of ["two words", "a&b", ""])
      await assert.rejects(versionAssetURLs(root, version), /Version must contain only/);
    await writeFile(join(base, "outside.js"), "");
    // Valid files on both sides of page.html in directory order.
    const valid = ["a.js", "z.js"];
    for (const name of valid) await writeFile(join(root, name), 'import "./worker.js";\n');
    for (const url of ["./missing.js", "../outside.js"]) {
      await writeFile(join(root, "page.html"), `<script type="module" src="${url}"></script>`);
      await assert.rejects(versionAssetURLs(root, "v2"), { message: `page.html references ${url}, which is not a file in the site.` });
      // Nothing is rewritten when any reference is rejected.
      for (const name of valid) assert.equal(await readFile(join(root, name), "utf8"), 'import "./worker.js";\n');
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
