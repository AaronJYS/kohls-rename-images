import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  readdir,
  stat,
  rm,
  open,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { buildPlan, APP_ID, OUTPUT_MARKER } from "../web/renamer.js";
import { scanFolder, exportPlan, nextOutputName } from "../web/folder-io.js";

// An adapter over real temporary files. This exercises byte preservation, recursive
// copying, and failures without granting a test harness access to personal folders.
class DiskFile {
  kind = "file";
  constructor(path, faults) {
    this.path = path;
    this.name = basename(path);
    this.faults = faults;
  }
  async getFile() {
    const info = await stat(this.path);
    return new File([await readFile(this.path)], this.name, {
      lastModified: Math.trunc(info.mtimeMs),
    });
  }
  async createWritable() {
    const chunks = [];
    const file = this;
    const stream = new WritableStream({
      write(chunk) {
        if (file.name === file.faults.failWrite)
          throw new DOMException("Disk full", "QuotaExceededError");
        chunks.push(
          typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk),
        );
      },
      async close() {
        await writeFile(file.path, Buffer.concat(chunks));
      },
    });
    // Browser writable streams also expose convenient write/close methods.
    const direct = async (method, value) => {
      const writer = stream.getWriter();
      try {
        return await writer[method](value);
      } finally {
        writer.releaseLock();
      }
    };
    stream.write = (value) => direct("write", value);
    stream.close = () => direct("close");
    return stream;
  }
}

class DiskDirectory {
  kind = "directory";
  constructor(path, faults = {}) {
    this.path = path;
    this.name = basename(path);
    this.faults = faults;
  }
  async *values() {
    for (const entry of await readdir(this.path, { withFileTypes: true })) {
      yield entry.isDirectory()
        ? new DiskDirectory(join(this.path, entry.name), this.faults)
        : new DiskFile(join(this.path, entry.name), this.faults);
    }
  }
  async getFileHandle(name, options = {}) {
    const path = join(this.path, name);
    let info;
    try {
      info = await stat(path);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (!options.create) throw new DOMException("Not found", "NotFoundError");
      await (await open(path, "wx")).close();
    }
    if (info?.isDirectory())
      throw new DOMException("Is a directory", "TypeMismatchError");
    return new DiskFile(path, this.faults);
  }
  async getDirectoryHandle(name, options = {}) {
    const path = join(this.path, name);
    if (options.create) await mkdir(path, { recursive: true });
    try {
      if (!(await stat(path)).isDirectory())
        throw new DOMException("Is a file", "TypeMismatchError");
    } catch (error) {
      if (error.code === "ENOENT")
        throw new DOMException("Not found", "NotFoundError");
      throw error;
    }
    return new DiskDirectory(path, this.faults);
  }
  async queryPermission() {
    return this.faults.denied ? "denied" : "granted";
  }
}

async function fixture(t) {
  const path = await mkdtemp(join(tmpdir(), "kohls-io-test-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  const root = new DiskDirectory(path);
  await mkdir(join(path, "nested", "empty"), { recursive: true });
  const files = {
    "51104.BK (1).jpg": Buffer.from([0, 255, 1, 128, 72]),
    "51104.BK (3) genai.png": Buffer.from("png fixture"),
    "nested/22.NV dims.tiff": Buffer.from("tiff fixture"),
    "nested/22.NV (2).JPG": Buffer.from("jpg fixture"),
    "unmatched.webp": Buffer.from("unmatched image fixture"),
    "notes.pdf": Buffer.from("pdf fixture"),
    "_rename_log.csv": Buffer.from("an earlier source log"),
  };
  for (const [name, content] of Object.entries(files))
    await writeFile(join(path, name), content);
  return { root, files };
}

test("preview writes nothing, export creates a child copy with exact bytes and a separate CSV", async (t) => {
  const { root, files } = await fixture(t);
  const before = await readdir(root.path);
  const snapshot = await scanFolder(root);
  const plan = buildPlan(snapshot.entries);
  assert.deepEqual(await readdir(root.path), before);
  const result = await exportPlan(root, plan);
  assert.equal(result.completedFiles, Object.keys(files).length);
  assert.equal(result.outputName, `${root.name}_Kohl`);
  assert.equal(result.logName, "_rename_log_DUP2.csv");
  for (const file of plan.files) {
    assert.deepEqual(
      await readFile(join(root.path, file.relativePath)),
      files[file.relativePath],
      "original remains unchanged",
    );
    assert.deepEqual(
      await readFile(join(root.path, result.outputName, file.outputPath)),
      files[file.relativePath],
      "copy preserves bytes",
    );
  }
  assert.ok(
    (
      await stat(join(root.path, result.outputName, "nested/empty"))
    ).isDirectory(),
  );
  const marker = JSON.parse(
    await readFile(join(root.path, result.outputName, OUTPUT_MARKER), "utf8"),
  );
  assert.equal(marker.status, "complete");
  assert.equal(marker.completedFiles, Object.keys(files).length);
  assert.match(
    await readFile(join(root.path, result.outputName, result.logName), "utf8"),
    /51104_Black_MAIN.jpg/,
  );
});

test("subsequent scans exclude generated output and choose a fresh child folder", async (t) => {
  const { root } = await fixture(t);
  const first = buildPlan((await scanFolder(root)).entries);
  const result = await exportPlan(root, first);
  const next = await scanFolder(root);
  assert.deepEqual(next.excluded, [result.outputName]);
  assert.deepEqual(
    next.entries.map((e) => e.relativePath),
    (await scanFolder(root)).entries.map((e) => e.relativePath),
  );
  assert.equal(buildPlan(next.entries).files.length, first.files.length);
  assert.equal(await nextOutputName(root), `${root.name}_Kohl_2`);
  await assert.rejects(
    scanFolder(await root.getDirectoryHandle(result.outputName)),
    /generated output folder/,
  );
});

test("disk-write failure reports an incomplete output and leaves all originals intact", async (t) => {
  const { root, files } = await fixture(t);
  const plan = buildPlan((await scanFolder(root)).entries);
  root.faults.failWrite = "51104_Black_MAIN.jpg";
  let failure;
  await assert.rejects(exportPlan(root, plan), (error) => {
    failure = error;
    return error.name === "QuotaExceededError";
  });
  const marker = JSON.parse(
    await readFile(join(root.path, failure.outputName, OUTPUT_MARKER), "utf8"),
  );
  assert.equal(marker.status, "incomplete");
  assert.deepEqual((await scanFolder(root)).excluded, [failure.outputName]);
  for (const [name, content] of Object.entries(files))
    assert.deepEqual(await readFile(join(root.path, name)), content);
});

test("cancellation between files leaves a marked incomplete output, not a success report", async (t) => {
  const { root } = await fixture(t);
  const plan = buildPlan((await scanFolder(root)).entries);
  const controller = new AbortController();
  let failure;
  await assert.rejects(
    exportPlan(root, plan, {
      signal: controller.signal,
      onProgress: ({ completedFiles }) => {
        if (completedFiles === 1) controller.abort();
      },
    }),
    (error) => {
      failure = error;
      return error.name === "AbortError";
    },
  );
  assert.equal(failure.completedFiles, 1);
  const marker = JSON.parse(
    await readFile(join(root.path, failure.outputName, OUTPUT_MARKER), "utf8"),
  );
  assert.equal(marker.status, "incomplete");
  assert.ok(
    !(await readdir(join(root.path, failure.outputName))).includes(
      plan.logName,
    ),
  );
});

test("revoked permissions and pre-cancelled operations create no output", async (t) => {
  const { root } = await fixture(t);
  const plan = buildPlan((await scanFolder(root)).entries);
  const before = await readdir(root.path);
  root.faults.denied = true;
  await assert.rejects(exportPlan(root, plan), { name: "NotAllowedError" });
  root.faults.denied = false;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(exportPlan(root, plan, { signal: controller.signal }), {
    name: "AbortError",
  });
  assert.deepEqual(await readdir(root.path), before);
});

test("files changed after the preview fail visibly instead of copying stale input", async (t) => {
  const { root } = await fixture(t);
  const plan = buildPlan((await scanFolder(root)).entries);
  await writeFile(
    join(root.path, "51104.BK (1).jpg"),
    "changed contents after preview",
  );
  await assert.rejects(exportPlan(root, plan), /changed after the preview/);
});

test("marker detection excludes only identified app outputs", async (t) => {
  const { root } = await fixture(t);
  const ordinary = await root.getDirectoryHandle("ordinary", { create: true });
  await writeFile(join(ordinary.path, OUTPUT_MARKER), "null");
  const generated = await root.getDirectoryHandle("earlier-run", {
    create: true,
  });
  await writeFile(
    join(generated.path, OUTPUT_MARKER),
    JSON.stringify({ app: APP_ID, version: 1, status: "incomplete" }),
  );
  const snapshot = await scanFolder(root);
  assert.deepEqual(snapshot.excluded, ["earlier-run"]);
  assert.ok(
    snapshot.entries.some(
      (entry) => entry.relativePath === `ordinary/${OUTPUT_MARKER}`,
    ),
  );
});
