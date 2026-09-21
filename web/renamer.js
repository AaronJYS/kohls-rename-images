// Browser port of rename_images.py. Keep defaults and role precedence in sync.
// This module plans names without reading file contents or writing to disk.
export const COLOR_MAP = Object.freeze({
  BK: "Black",
  BR: "Brown",
  BN: "Bone",
  TN: "Tan",
  NV: "Navy",
  GY: "Grey",
  WH: "White",
  RD: "Red",
  BL: "Blue",
  CG: "Cognac",
  SD: "Saddle",
  BUR: "Burgundy",
  CAM: "Camel",
  OLV: "Olive",
  TAU: "Taupe",
  YL: "Yellow",
  TP: "Taupe",
  CM: "Camel",
  OL: "Olive",
  ST: "Stone",
});
export const DEFAULTS = Object.freeze({
  roleOverrides: {},
  genaiFiles: [],
  dimsKeywords: ["dim", "measure", "ruler", "scale"],
  genaiKeywords: ["genai", "gen-ai", "gen_ai", "aimodel", "ai-model"],
  numberFirstAlt: false,
  mainIndex: 1,
  promoteLowestIfNoMain: true,
  lowercaseExtension: false,
  requireDigitInStyle: true,
  colorMaxLength: 20,
});
export const IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".tif",
  ".tiff",
  ".webp",
  ".gif",
  ".bmp",
]);
export const OUTPUT_MARKER = ".kohls-renamer.json";
export const APP_ID = "jys-kohls-image-renamer";
export const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export const pathKey = (path) => path.normalize("NFC").toLowerCase();
const join = (folder, name) => (folder ? `${folder}/${name}` : name);

export function splitFilename(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1
    ? { stem: name.slice(0, dot), extension: name.slice(dot) }
    : { stem: name, extension: "" };
}

export function parseFilename(name, options = {}) {
  const config = { ...DEFAULTS, ...options };
  const style = config.requireDigitInStyle ? "(?=[A-Za-z0-9\\-]*\\d)" : "";
  const expression = new RegExp(
    `^\\s*(${style}[A-Za-z0-9][A-Za-z0-9\\-]*?)[._\\-\\s]+([A-Za-z]{1,${config.colorMaxLength}}\\d?)(?:[._\\-\\s]*\\((\\d+)\\)|[._\\-\\s]+(\\d+))?(?:[\\s._\\-]+.*)?\\s*$`,
  );
  const { stem, extension } = splitFilename(name);
  const match = expression.exec(stem);
  if (!match) return null;
  return {
    style: match[1].toUpperCase(),
    code: match[2].toUpperCase(),
    index: Number(match[3] || match[4] || 0),
    sku: match[1],
    colorRaw: match[2],
    stem,
    extension,
  };
}

function assignRoles(files, config, notes, label) {
  const roles = new Map();
  const taken = new Set();
  const overrides = new Map(
    Object.entries(config.roleOverrides).map(([name, role]) => [
      name.toUpperCase(),
      role.toUpperCase(),
    ]),
  );
  const altLabel = (n) =>
    n === 1 && !config.numberFirstAlt ? "ALT" : `ALT${n}`;
  for (const file of files) {
    const role = overrides.get(file.name.toUpperCase());
    if (role) {
      roles.set(file, role);
      taken.add(role);
    }
  }
  for (const file of files) {
    if (
      !roles.has(file) &&
      !taken.has("DIMS") &&
      config.dimsKeywords.some((word) =>
        file.parsed.stem.toLowerCase().includes(word),
      )
    ) {
      roles.set(file, "DIMS");
      taken.add("DIMS");
    }
  }
  if (!taken.has("MAIN")) {
    const free = files.filter((file) => !roles.has(file));
    let main = free.find((file) => file.parsed.index === config.mainIndex);
    if (
      !main &&
      files.length === 1 &&
      files[0].parsed.index === 0 &&
      free.length
    )
      main = free[0];
    if (!main && free.length) {
      if (config.promoteLowestIfNoMain) {
        main = free[0];
        notes.push(
          `${label}: no (${config.mainIndex}) shot — promoted ${main.name} to MAIN.`,
        );
      } else
        notes.push(
          `${label}: no (${config.mainIndex}) shot — group has no MAIN.`,
        );
    }
    if (main) {
      roles.set(main, "MAIN");
    }
  }
  let alt = 1;
  for (const file of files) {
    if (roles.has(file)) continue;
    while (taken.has(altLabel(alt))) alt++;
    roles.set(file, altLabel(alt));
    taken.add(altLabel(alt));
    alt++;
  }
  return roles;
}

export function validateName(name) {
  if (
    !name ||
    /[<>:"/\\|?*\u0000-\u001f]/.test(name) ||
    /[. ]$/.test(name) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ||
    new TextEncoder().encode(name).length > 255
  ) {
    throw new Error(
      `Cannot save the filename “${name}” on Windows and macOS. Check the color map and naming settings.`,
    );
  }
}

function availableName(name, folder, occupied, ownKey = null) {
  let result = name;
  let n = 2;
  const { stem, extension } = splitFilename(name);
  const isTaken = (candidate) => {
    const key = pathKey(join(folder, candidate));
    return (occupied.get(key) || 0) > (key === ownKey ? 1 : 0);
  };
  while (isTaken(result)) result = `${stem}_DUP${n++}${extension}`;
  validateName(result);
  return result;
}

/** Snapshot entries use relative paths; directories are included to reserve names. */
export function buildPlan(entries, options = {}) {
  const config = { ...DEFAULTS, ...options };
  const colors = { ...COLOR_MAP, ...options.colors };
  const nameLookup = new Map(
    Object.values(colors).map((name) => [name.toUpperCase(), name]),
  );
  const groups = new Map();
  const occupied = new Map();
  const notes = [],
    unknown = new Set();
  const sorted = [...entries].sort((a, b) =>
    compare(a.relativePath, b.relativePath),
  );
  const files = [];
  for (const entry of sorted) {
    if (
      !entry.relativePath ||
      entry.relativePath
        .split("/")
        .some((segment) => !segment || segment === "." || segment === "..")
    ) {
      throw new Error(
        "A file has an invalid relative path. Select the folder again.",
      );
    }
    const key = pathKey(entry.relativePath);
    occupied.set(key, (occupied.get(key) || 0) + 1);
    if (key === OUTPUT_MARKER)
      throw new Error(
        `This folder contains the reserved file ${OUTPUT_MARKER}. Select the original source folder.`,
      );
    if (entry.kind === "directory") continue;
    const slash = entry.relativePath.lastIndexOf("/");
    const folder = slash < 0 ? "" : entry.relativePath.slice(0, slash);
    const name = entry.relativePath.slice(slash + 1);
    const supported = IMAGE_EXTENSIONS.has(
      splitFilename(name).extension.toLowerCase(),
    );
    const parsed = supported ? parseFilename(name, config) : null;
    const file = {
      ...entry,
      name,
      folder,
      parsed,
      supported,
      role: null,
      genai: false,
      outputName: name,
      outputPath: entry.relativePath,
      collision: false,
    };
    files.push(file);
    if (parsed) {
      const key = JSON.stringify([folder, parsed.style, parsed.code]);
      if (!groups.has(key))
        groups.set(key, {
          folder,
          style: parsed.style,
          code: parsed.code,
          files: [],
        });
      groups.get(key).files.push(file);
    }
  }
  const orderedGroups = [...groups.values()].sort(
    (a, b) =>
      compare(a.folder, b.folder) ||
      compare(a.style, b.style) ||
      compare(a.code, b.code),
  );
  for (const group of orderedGroups) {
    // Like Python, casing of the SKU and unknown color comes from the first path.
    const first = group.files[0].parsed;
    const colorName = Object.hasOwn(colors, group.code)
      ? colors[group.code]
      : nameLookup.get(group.code) || first.colorRaw;
    if (!Object.hasOwn(colors, group.code) && !nameLookup.has(group.code))
      unknown.add(group.code);
    group.files.sort(
      (a, b) =>
        a.parsed.index - b.parsed.index ||
        compare(a.name.toLowerCase(), b.name.toLowerCase()),
    );
    const roles = assignRoles(
      group.files,
      config,
      notes,
      `${first.sku} ${colorName}`,
    );
    const genaiFiles = new Set(
      config.genaiFiles.map((name) => name.toUpperCase()),
    );
    for (const file of group.files) {
      file.role = roles.get(file);
      file.genai =
        genaiFiles.has(file.name.toUpperCase()) ||
        config.genaiKeywords.some((word) =>
          file.parsed.stem.toLowerCase().includes(word),
        );
      const parts = [first.sku, colorName];
      if (file.genai && file.role !== "DIMS") parts.push("GENAI");
      parts.push(file.role);
      const extension = config.lowercaseExtension
        ? file.parsed.extension.toLowerCase()
        : file.parsed.extension;
      const requestedName = parts.join("_") + extension;
      const ownKey = pathKey(file.relativePath);
      file.outputName = availableName(
        requestedName,
        file.folder,
        occupied,
        ownKey,
      );
      file.outputPath = join(file.folder, file.outputName);
      file.collision = file.outputName !== requestedName;
      occupied.set(ownKey, occupied.get(ownKey) - 1);
      const targetKey = pathKey(file.outputPath);
      occupied.set(targetKey, (occupied.get(targetKey) || 0) + 1);
    }
  }
  // Reserve a separate report if the source already contains a rename log.
  const logName = availableName("_rename_log.csv", "", occupied);
  const collisions = files.filter((file) => file.collision).length;
  const skipped = files.filter((file) => file.supported && !file.parsed);
  const matched = files.filter((file) => file.parsed).length;
  return {
    files,
    directories: sorted.filter((entry) => entry.kind === "directory"),
    groupCount: groups.size,
    matched,
    unchanged: files.length - matched,
    skipped,
    collisions,
    notes,
    unknownColors: [...unknown].sort(compare),
    logName,
    totalBytes: files.reduce((total, file) => total + (file.size || 0), 0),
  };
}

export function renameLog(plan) {
  // Prefix formula-looking values so filenames remain inert when opened in Excel.
  const cell = (value) => {
    let text = String(value);
    if (/^[=+\-@\t\r\n]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  const rows = [
    ["original", "renamed"],
    ...plan.files
      .filter((file) => file.parsed)
      .map((file) => [file.relativePath, file.outputName]),
  ];
  return (
    "\ufeff" + rows.map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n"
  );
}

/** A two-column CSV parser; supports BOM, quoted fields, CRLF, and an optional header. */
export function parseColorCSV(text) {
  const rows = [];
  let row = [],
    field = "",
    quoted = false,
    closedQuote = false;
  text = text.replace(/^\ufeff/, "");
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
        closedQuote = true;
      } else field += char;
    } else if (char === '"' && !field && !closedQuote) quoted = true;
    else if (char === "," || char === "\n" || char === "\r") {
      row.push(field);
      field = "";
      closedQuote = false;
      if (char !== ",") {
        if (char === "\r" && text[i + 1] === "\n") i++;
        rows.push(row);
        row = [];
      }
    } else {
      if (closedQuote || char === '"')
        throw new Error("Invalid CSV quoting. Use two columns: code,name.");
      field += char;
    }
  }
  if (quoted) throw new Error("The color CSV has an unclosed quote.");
  if (field || row.length || closedQuote) {
    row.push(field);
    rows.push(row);
  }
  const colors = Object.create(null);
  for (let i = 0; i < rows.length; i++) {
    const cells = rows[i].map((value) => value.trim());
    if (cells.every((value) => !value)) continue;
    if (
      i === 0 &&
      cells[0].toLowerCase() === "code" &&
      cells[1]?.toLowerCase() === "name"
    )
      continue;
    if (cells.length !== 2 || !/^[a-z]{1,20}\d?$/i.test(cells[0]) || !cells[1])
      throw new Error(
        `Invalid color CSV row ${i + 1}. Use code,name with a non-empty color name.`,
      );
    validateName(cells[1]);
    colors[cells[0].toUpperCase()] = cells[1];
  }
  if (!Object.keys(colors).length)
    throw new Error("The color CSV contains no color entries.");
  return colors;
}
