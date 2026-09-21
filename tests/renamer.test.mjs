import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  buildPlan,
  parseFilename,
  parseColorCSV,
  renameLog,
  COLOR_MAP,
  DEFAULTS,
  OUTPUT_MARKER,
} from "../web/renamer.js";

const cwd = fileURLToPath(new URL("..", import.meta.url));
const entries = (names) =>
  names.map((relativePath) => ({ kind: "file", relativePath, size: 1 }));
const namesOf = (plan) =>
  Object.fromEntries(
    plan.files
      .filter((file) => file.parsed)
      .map((file) => [file.relativePath, file.outputName]),
  );

function python(script, data) {
  const run = spawnSync(process.env.PYTHON || "python3", ["-B", "-c", script], {
    cwd,
    input: JSON.stringify(data),
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

test("browser configuration stays aligned with the existing Python tool", () => {
  const config = python(
    `import rename_images as r, json
print(json.dumps({'colors':r.COLOR_MAP,'dims':r.DIMS_KEYWORDS,'genai':r.GENAI_KEYWORDS,'main':r.MAIN_INDEX,'number':r.NUMBER_FIRST_ALT,'lower':r.LOWERCASE_EXTENSION,'promote':r.PROMOTE_LOWEST_IF_NO_MAIN,'digit':r.REQUIRE_DIGIT_IN_STYLE,'max':r.COLOR_MAX_LEN,'overrides':r.ROLE_OVERRIDES,'genai_files':list(r.GENAI_FILES)}))`,
    null,
  );
  assert.deepEqual(config, {
    colors: COLOR_MAP,
    dims: DEFAULTS.dimsKeywords,
    genai: DEFAULTS.genaiKeywords,
    main: DEFAULTS.mainIndex,
    number: DEFAULTS.numberFirstAlt,
    lower: DEFAULTS.lowercaseExtension,
    promote: DEFAULTS.promoteLowestIfNoMain,
    digit: DEFAULTS.requireDigitInStyle,
    max: DEFAULTS.colorMaxLength,
    overrides: DEFAULTS.roleOverrides,
    genai_files: DEFAULTS.genaiFiles,
  });
});

test("parsing matches Python across separators, casing, malformed names and extensions", () => {
  const names = [
    "51104.BK (1).jpg",
    "DP-1234.BK (12).JPG",
    "22003_Black (2).png",
    "51104.BK.jpg",
    "51104_BK_3.tif",
    "22890.CG.jpg",
    "abc-def.jpg",
    "weird-name.jpg",
    "51104.TN (3) dims.jpeg",
    "AB12-BL-4.gif",
    "42.XX1.webp",
    "12.BLACK.JPEG",
    ".jpg",
    "51104.BK.",
    "51104.BK (1)(2).jpg",
  ];
  const expected = python(
    `import rename_images as r, json, sys
from pathlib import Path
print(json.dumps([r.parse(Path(n)) for n in json.load(sys.stdin)]))`,
    names,
  );
  const actual = names.map((name) => {
    const p = parseFilename(name);
    return p ? [p.style, p.code, p.index, p.sku, p.colorRaw] : null;
  });
  assert.deepEqual(actual, expected);
});

test("complete rename plans match the Python CLI on representative multi-folder input", () => {
  const names = ["readme.txt", "unrecognized.webp", "note.pdf"];
  for (const [style, color, extension] of [
    ["51104", "BK", "jpg"],
    ["22003", "BLACK", "JPG"],
    ["72", "XX", "tiff"],
  ]) {
    for (const index of [1, 2, 6, 10])
      names.push(`${style}.${color} (${index}).${extension}`);
    names.push(
      `${style}.${color} dims.${extension}`,
      `${style}.${color} (12) genai.${extension}`,
    );
  }
  names.push(
    "nested/11.BN.jpg",
    "nested/12.TN (3).jpeg",
    "nested/12.TN (5).jpeg",
    "nested/13.WH (1) ruler.tif",
    "nested/13.WH (7).tif",
    "aliased/31.BK (1).jpg",
    "aliased/31.Black (1).jpg",
  );
  const expected = python(
    `import rename_images as r, json, sys, tempfile, csv, io, contextlib
from pathlib import Path
names=json.load(sys.stdin)
with tempfile.TemporaryDirectory() as tmp:
    src=Path(tmp)/'source'; src.mkdir()
    for name in names:
        path=src/name; path.parent.mkdir(parents=True,exist_ok=True); path.write_bytes(b'fixture')
    dest=Path(tmp)/'output'
    with contextlib.redirect_stdout(io.StringIO()): r.process(src,dest,False,False)
    with (dest/'_rename_log.csv').open() as fh: result={Path(original).as_posix():renamed for original,renamed in list(csv.reader(fh))[1:]}
    print(json.dumps(result))`,
    names,
  );
  const plan = buildPlan(entries(names));
  assert.deepEqual(namesOf(plan), expected);
  assert.deepEqual(plan.unknownColors, ["XX"]);
  assert.equal(plan.unchanged, 3);
});

test("dimensions precede MAIN, alt numbers close gaps, GENAI excludes DIMS", () => {
  const plan = buildPlan(
    entries([
      "42.BK (1) dims genai.jpg",
      "42.BK (4).jpg",
      "42.BK (7) gen-ai.jpg",
      "42.BK (20).jpg",
    ]),
  );
  assert.deepEqual(namesOf(plan), {
    "42.BK (1) dims genai.jpg": "42_Black_DIMS.jpg",
    "42.BK (20).jpg": "42_Black_ALT2.jpg",
    "42.BK (4).jpg": "42_Black_MAIN.jpg",
    "42.BK (7) gen-ai.jpg": "42_Black_GENAI_ALT.jpg",
  });
  assert.equal(plan.notes.length, 1);
});

test("overrides and naming switches are respected", () => {
  const plan = buildPlan(
    entries(["42.BK (1).JPG", "42.BK (2).JPG", "42.BK (3).JPG"]),
    {
      roleOverrides: { "42.bk (3).jpg": "MAIN" },
      genaiFiles: ["42.bk (1).jpg"],
      numberFirstAlt: true,
      lowercaseExtension: true,
    },
  );
  assert.equal(namesOf(plan)["42.BK (3).JPG"], "42_Black_MAIN.jpg");
  assert.equal(namesOf(plan)["42.BK (1).JPG"], "42_Black_GENAI_ALT1.jpg");
  assert.equal(namesOf(plan)["42.BK (2).JPG"], "42_Black_ALT2.jpg");
});

test("collision planning reserves filenames and directories case-insensitively", () => {
  const plan = buildPlan([
    ...entries(["42.BK (1).jpg", "42.Black (1).jpg", "_rename_log.csv"]),
    { kind: "directory", relativePath: "42_BLACK_MAIN.jpg" },
  ]);
  assert.equal(plan.collisions, 2);
  assert.equal(namesOf(plan)["42.BK (1).jpg"], "42_Black_MAIN_DUP2.jpg");
  assert.equal(namesOf(plan)["42.Black (1).jpg"], "42_Black_MAIN_DUP3.jpg");
  assert.equal(plan.logName, "_rename_log_DUP2.csv");
  assert.equal(
    plan.files.find((file) => file.name === "_rename_log.csv").outputName,
    "_rename_log.csv",
  );
});

test("CSV color maps support headers, BOM, quoted commas and case normalization", () => {
  const colors = parseColorCSV(
    '\ufeffcode,name\r\nbk,Jet Black\r\nXX,"Blue, Green"\r\n',
  );
  const plan = buildPlan(entries(["42.BK.jpg", "42.XX.png"]), { colors });
  assert.equal(namesOf(plan)["42.BK.jpg"], "42_Jet Black_MAIN.jpg");
  assert.equal(namesOf(plan)["42.XX.png"], "42_Blue, Green_MAIN.png");
  assert.deepEqual(plan.unknownColors, []);
  assert.match(renameLog(plan), /"42_Blue, Green_MAIN.png"/);
});

test("invalid color maps and dangerous output paths fail during planning", () => {
  for (const csv of [
    "BK,../Black",
    "BK,",
    'BK,"unclosed',
    'BK,Bad"quote',
    "code,name",
    "BK,NUL",
    "BK,Black,extra",
  ])
    assert.throws(() => parseColorCSV(csv));
  assert.throws(() => buildPlan(entries(["../42.BK.jpg"])));
  assert.throws(() => buildPlan(entries([OUTPUT_MARKER])));
});

test("CSV report escapes quotes and prevents spreadsheet formula execution", () => {
  const plan = buildPlan(
    entries(["=folder/42.BK.jpg", 'folder"quoted/43.NV.jpg']),
  );
  const log = renameLog(plan);
  assert.match(log, /"'=folder\/42.BK.jpg"/);
  assert.match(log, /"folder""quoted\/43.NV.jpg"/);
  assert.ok(log.startsWith("\ufeff"));
});
