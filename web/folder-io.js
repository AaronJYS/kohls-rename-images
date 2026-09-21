import {
  APP_ID,
  OUTPUT_MARKER,
  pathKey,
  renameLog,
  validateName,
} from "./renamer.js";

function checkAbort(signal) {
  if (signal?.aborted)
    throw new DOMException("The operation was stopped.", "AbortError");
}

async function readMarker(directory) {
  let file;
  try {
    file = await (await directory.getFileHandle(OUTPUT_MARKER)).getFile();
  } catch (error) {
    if (error.name === "NotFoundError" || error.name === "TypeMismatchError")
      return null;
    throw error;
  }
  if (file.size > 8192) return null;
  try {
    const marker = JSON.parse(await file.text());
    return marker?.app === APP_ID && marker.version === 1 ? marker : null;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

/** Fully snapshot the source BEFORE creating the child output directory. */
export async function scanFolder(root, { onProgress = () => {}, signal } = {}) {
  if (await readMarker(root))
    throw new Error(
      "This is a generated output folder. Select the original folder that contains it instead.",
    );
  const entries = [],
    excluded = [];
  const stack = [{ handle: root, path: "" }];
  while (stack.length) {
    checkAbort(signal);
    const { handle, path } = stack.pop();
    for await (const child of handle.values()) {
      checkAbort(signal);
      const relativePath = path ? `${path}/${child.name}` : child.name;
      if (child.kind === "directory") {
        if (await readMarker(child)) {
          excluded.push(relativePath);
          continue;
        }
        entries.push({ kind: "directory", relativePath, handle: child });
        stack.push({ handle: child, path: relativePath });
      } else {
        const file = await child.getFile();
        entries.push({
          kind: "file",
          relativePath,
          handle: child,
          size: file.size,
          lastModified: file.lastModified,
        });
      }
      onProgress(entries.length);
    }
  }
  return { entries, excluded };
}

export async function nextOutputName(root) {
  const existing = new Set();
  for await (const handle of root.values()) existing.add(pathKey(handle.name));
  let sourceName = root.name;
  while (
    sourceName.length > 220 ||
    new TextEncoder().encode(sourceName).length > 220
  )
    sourceName = Array.from(sourceName).slice(0, -1).join("");
  const base = `${sourceName}_Kohl`;
  let name = base,
    index = 2;
  while (existing.has(pathKey(name))) name = `${base}_${index++}`;
  validateName(name);
  return name;
}

async function assertAbsent(directory, name) {
  try {
    await directory.getFileHandle(name);
  } catch (error) {
    if (error.name === "NotFoundError") return;
    if (error.name !== "TypeMismatchError") throw error;
  }
  throw new Error(
    `“${name}” already exists in the output. Select the source again to create a fresh copy.`,
  );
}

async function newFile(directory, name) {
  await assertAbsent(directory, name);
  return directory.getFileHandle(name, { create: true });
}

async function writeText(handle, text) {
  const writable = await handle.createWritable({ mode: "exclusive" });
  try {
    await writable.write(text);
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => {});
    throw error;
  }
}

/** No deletes and no source-file writes. A failed run retains an incomplete marker. */
export async function exportPlan(
  root,
  plan,
  { signal, onProgress = () => {} } = {},
) {
  let outputName = null,
    completedFiles = 0,
    copiedBytes = 0;
  try {
    checkAbort(signal);
    if ((await root.queryPermission({ mode: "readwrite" })) !== "granted")
      throw new DOMException(
        "Write access was not granted. Select the folder and allow changes.",
        "NotAllowedError",
      );
    const candidateName = await nextOutputName(root);
    checkAbort(signal);
    // Recheck immediately before creation; the UI also uses a cross-tab Web Lock.
    await assertAbsent(root, candidateName);
    const output = await root.getDirectoryHandle(candidateName, {
      create: true,
    });
    // Never reuse a populated directory if it appeared between check and creation.
    for await (const entry of output.values())
      throw new Error(
        `The output folder is no longer empty (${entry.name}). Select the source again.`,
      );
    outputName = candidateName;
    const markerHandle = await newFile(output, OUTPUT_MARKER);
    const marker = {
      app: APP_ID,
      version: 1,
      status: "incomplete",
      source: root.name,
      createdAt: new Date().toISOString(),
    };
    await writeText(markerHandle, JSON.stringify(marker, null, 2));
    const directories = new Map([["", output]]);
    async function getDirectory(path) {
      if (directories.has(path)) return directories.get(path);
      const parts = path.split("/");
      const name = parts.pop();
      const parent = await getDirectory(parts.join("/"));
      const handle = await parent.getDirectoryHandle(name, { create: true });
      directories.set(path, handle);
      return handle;
    }
    for (const entry of plan.directories) {
      checkAbort(signal);
      await getDirectory(entry.relativePath);
    }
    const progress = (path) =>
      onProgress({
        completedFiles,
        totalFiles: plan.files.length,
        copiedBytes,
        totalBytes: plan.totalBytes,
        path,
        outputName,
      });
    for (const entry of plan.files) {
      checkAbort(signal);
      const file = await entry.handle.getFile();
      if (file.size !== entry.size || file.lastModified !== entry.lastModified)
        throw new Error(
          `“${entry.relativePath}” changed after the preview. Select the source again to refresh the filenames.`,
        );
      const directory = await getDirectory(entry.folder);
      const target = await newFile(directory, entry.outputName);
      const writable = await target.createWritable({ mode: "exclusive" });
      progress(entry.relativePath);
      const counter = new TransformStream({
        transform(chunk, controller) {
          checkAbort(signal);
          copiedBytes += chunk.byteLength;
          controller.enqueue(chunk);
          progress(entry.relativePath);
        },
      });
      await file.stream().pipeThrough(counter).pipeTo(writable, { signal });
      completedFiles++;
      progress(entry.relativePath);
    }
    checkAbort(signal);
    await writeText(await newFile(output, plan.logName), renameLog(plan));
    await writeText(
      markerHandle,
      JSON.stringify(
        {
          ...marker,
          status: "complete",
          completedFiles,
          completedAt: new Date().toISOString(),
          log: plan.logName,
        },
        null,
        2,
      ),
    );
    return { outputName, completedFiles, copiedBytes, logName: plan.logName };
  } catch (cause) {
    const error = new Error(cause.message, { cause });
    error.name = cause.name;
    error.outputName = outputName;
    error.completedFiles = completedFiles;
    throw error;
  }
}
