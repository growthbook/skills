#!/usr/bin/env node
/**
 * Helpers for .github/workflows/sync-from-growthbook.yml.
 *
 *   range        Resolve the GrowthBook commits to review since the last sync.
 *   prs          Turn commit-to-PR lookups into the PR list and a commit map.
 *   target       Choose the sync PR to add to and list paired skills PRs.
 *   changes      Write each reviewed commit's diff for the model to read.
 *   prompt       Render prompt.md with this run's inputs.
 *   guard        Reject skill edits that break the authoring rules.
 *   section      Write the PR description section and commit message.
 *   body         Build the sync PR description.
 *   questions    Write the "Needs a human" comment for the tracking issue.
 *
 * The workflow copies this directory, the GrowthBook drift checker, and the
 * spec to a trusted directory before the model runs, and runs every command
 * from there.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MAX_CHANGED_LINES = 200;
export const MAX_FILES = 8;
const DESCRIPTION_LIMIT = 1024;
const BODY_LIMIT = 60000;
const DIFF_LIMIT = 150000;

// Phrases that read like a changelog or a chat, not a skill. They are
// reported as warnings in the PR description for the reviewer, not failures:
// some are correct in context.
export const PHRASE_WARNINGS = [
  [
    /growthbook\/growthbook#|\/pull\/\d+|\bskills#\d+|(^|[\s(])#\d{2,}\b/,
    "PR or issue reference",
  ],
  [
    /\b(as of (v?\d|today|now|this)|(was|were) (changed|renamed) (to|in)|newly added|recent (change|update)s?)\b/i,
    "changelog wording",
  ],
  [
    /(^|[.(]\s*|^\s*[-*]\s+)(Previously|Formerly)\b|\(previously\b/,
    "changelog wording",
  ],
  [/\b(TODO|FIXME|XXX|TBD)\b/, "unfinished-work marker"],
  [/<!--/, "HTML comment"],
  [/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B50}\u{2705}\u{FE0F}]/u, "emoji"],
  [/\S[ \t]+$/, "trailing whitespace"],
];

// Routers name the Claude Code plugin in their install preamble, which skills
// CLAUDE.md allows; workflow files stay client-neutral.
export const REFERENCE_PHRASE_WARNINGS = [
  [/\b(Claude|Anthropic|OpenAI|ChatGPT|as an AI)\b/, "provider name"],
];

export const SECRET_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/,
  /\bsk-[A-Za-z0-9]{32,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

// Ignore repo hooks, fsmonitor, and user config so nothing in a checkout can
// run code or change what git reports.
function git(cwd, args, options = {}) {
  return execFileSync(
    "git",
    [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-C",
      cwd,
      ...args,
    ],
    {
      encoding: options.encoding === undefined ? "utf8" : options.encoding,
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    },
  );
}

function readIfExists(file) {
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

function readJson(file, fallback) {
  const text = readIfExists(file);
  return text ? JSON.parse(text) : fallback;
}

function output(values) {
  const lines = Object.entries(values).map(([k, v]) => `${k}=${v ?? ""}`);
  process.stdout.write(lines.join("\n") + "\n");
}

// Input lines are JSON objects: { sha, number, title, linked: [skills PRs] }.
export function collectPrs(jsonl) {
  const byNumber = new Map();
  const bySha = {};
  for (const line of jsonl.split("\n").filter(Boolean)) {
    const { sha, number, title, linked = [] } = JSON.parse(line);
    bySha[sha] = number;
    byNumber.set(number, { number, title, linkedSkillsPrs: linked });
  }
  return {
    prs: [...byNumber.values()].sort((a, b) => a.number - b.number),
    bySha,
  };
}

export function watchPaths(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function range() {
  const growthbookDir = env("GROWTHBOOK_DIR");
  const trusted = env("TRUSTED");
  const syncDir = env("SYNC_DIR");
  const after = git(growthbookDir, ["rev-parse", "HEAD"]).trim();
  let before = process.env.SINCE || process.env.STATE_SHA || "";
  let source = process.env.SINCE ? "since input" : "last sync";
  if (!before) {
    before = git(growthbookDir, [
      "rev-list",
      "-1",
      "--before=7 days ago",
      after,
    ]).trim();
    source = "no saved sync; last 7 days";
  }
  let ok = /^[0-9a-f]{7,40}$/.test(before);
  if (ok) {
    try {
      git(growthbookDir, ["merge-base", "--is-ancestor", before, after]);
    } catch {
      ok = false;
    }
  }
  if (!ok) {
    throw new Error(
      `Cannot review from "${before}" (${source}): not an ancestor of ${after}`,
    );
  }
  const paths = watchPaths(
    readFileSync(path.join(trusted, "watch-paths.txt"), "utf8"),
  );
  const commits = git(growthbookDir, [
    "log",
    "--format=%H",
    `${before}..${after}`,
    "--",
    ...paths,
  ])
    .split("\n")
    .filter(Boolean);
  writeFileSync(
    path.join(syncDir, "commits.txt"),
    commits.join("\n") + (commits.length ? "\n" : ""),
  );
  writeFileSync(
    path.join(trusted, "base-spec.yaml"),
    git(growthbookDir, [
      "show",
      `${before}:packages/back-end/generated/spec.yaml`,
    ]),
  );
  output({ before, after, commits: commits.length, source });
}

// Edits always go to the single sync PR. Skills PRs paired with a GrowthBook
// PR in the range (the skills PR names it, or the GrowthBook PR links it) are
// listed so the model leaves those changes to them; nothing is pushed there.
export function pickTarget({ openPrs, growthbookPrs, syncBranch }) {
  const paired = [];
  for (const gb of growthbookPrs) {
    const mention = new RegExp(
      `growthbook/growthbook(#|/pull/)${gb.number}\\b`,
    );
    for (const pr of openPrs) {
      if (pr.headRefName === syncBranch && !pr.isCrossRepository) continue;
      if (
        gb.linkedSkillsPrs.includes(pr.number) ||
        mention.test(pr.body ?? "")
      ) {
        paired.push({ growthbook: gb.number, skills: pr.number });
      }
    }
  }
  const syncPr = openPrs.find(
    (pr) => pr.headRefName === syncBranch && !pr.isCrossRepository,
  );
  return {
    kind: syncPr ? "sync" : "new",
    number: syncPr?.number ?? null,
    branch: syncBranch,
    headSha: syncPr?.headRefOid ?? "",
    files: (syncPr?.files ?? []).map((f) => f.path),
    paired,
  };
}

function changes() {
  const growthbookDir = env("GROWTHBOOK_DIR");
  const syncDir = env("SYNC_DIR");
  const trusted = env("TRUSTED");
  const dir = path.join(syncDir, "changes");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const prsBySha = readJson(path.join(syncDir, "commit-prs.json"), {});
  // The generated spec is summarized by drift.md; its diff would drown the rest.
  const paths = watchPaths(
    readFileSync(path.join(trusted, "watch-paths.txt"), "utf8"),
  ).filter((p) => !p.endsWith("generated/spec.yaml"));
  const commits = readIfExists(path.join(syncDir, "commits.txt"))
    .split("\n")
    .filter(Boolean);
  const index = ["# GrowthBook commits to review", ""];
  commits.forEach((sha, i) => {
    const file = `${String(i + 1).padStart(3, "0")}-${sha.slice(0, 10)}.diff`;
    let diff = git(growthbookDir, [
      "show",
      "--stat",
      "--patch",
      "--no-ext-diff",
      "--no-textconv",
      "--format=commit %H%nDate: %as%n%n%B",
      sha,
      "--",
      ...paths,
    ]);
    if (diff.length > DIFF_LIMIT) {
      diff = `${diff.slice(0, DIFF_LIMIT)}\n\n[Truncated at ${DIFF_LIMIT} characters. The rest of this commit is not shown.]\n`;
    }
    writeFileSync(path.join(dir, file), diff);
    const subject = git(growthbookDir, [
      "log",
      "-1",
      "--format=%s",
      sha,
    ]).trim();
    const pr = prsBySha[sha] ? ` (growthbook/growthbook#${prsBySha[sha]})` : "";
    index.push(`- \`changes/${file}\`: ${subject}${pr}`);
  });
  if (commits.length === 0) index.push("No watched commits in this range.");
  writeFileSync(path.join(dir, "index.md"), index.join("\n") + "\n");
}

export function renderPrompt(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    if (!(key in values)) throw new Error(`Unknown placeholder ${match}`);
    return values[key];
  });
}

export function targetDescription(target) {
  if (target.kind === "new") {
    return "No sync PR is open. Your edits start a new draft PR from `main`.";
  }
  const files = target.files.map((f) => `\`${f}\``).join(", ") || "nothing yet";
  return `Your edits are added to the open sync PR #${target.number}, which is checked out and up to date with \`main\`. It already changes: ${files}. Build on its changes; don't redo or undo them.`;
}

export function pairedDescription(paired) {
  if (!paired.length) return "None.";
  return paired
    .map(
      (p) =>
        `- growthbook/growthbook#${p.growthbook} has its own skills PR, #${p.skills}. Don't make skill changes caused by that GrowthBook PR; list them under "Checked, no change" as covered by #${p.skills}.`,
    )
    .join("\n");
}

// Frontmatter must be one `key: value` per line, as every skill in this repo
// is. Anything else (block scalars, continuation lines, unquoted values with
// ": " or " #") is either a parse error or a hidden extra key in YAML.
export function parseFrontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) return { error: "frontmatter is missing or malformed" };
  const entries = [];
  for (const line of match[1].split("\n")) {
    const kv = /^([A-Za-z0-9_-]+): (.*)$/.exec(line);
    if (!kv) {
      return { error: `frontmatter line is not \`key: value\`: \`${line}\`` };
    }
    const value = kv[2];
    const quoted = /^(["']).*\1$/.test(value);
    if (!quoted && (/: /.test(value) || / #/.test(value))) {
      return {
        error: `frontmatter \`${kv[1]}\` needs quotes: it contains ": " or " #"`,
      };
    }
    entries.push([kv[1], value]);
  }
  return { entries };
}

const sectionHeadings = (text) =>
  text
    .split("\n")
    .filter((line) => /^## /.test(line) && line !== "## Contents");

const isRouter = (file) => /^skills\/[^/]+\/SKILL\.md$/.test(file);

export function checkFile({ file, before, after, addedLines, skillsDir }) {
  const problems = [];
  const warnings = [];
  const fmBefore = parseFrontmatter(before);
  const fmAfter = parseFrontmatter(after);
  if (fmAfter.error) {
    problems.push(`${file}: ${fmAfter.error}`);
  } else if (!fmBefore.error) {
    const without = (entries) =>
      JSON.stringify(entries.filter(([key]) => key !== "description"));
    if (without(fmBefore.entries) !== without(fmAfter.entries)) {
      problems.push(`${file}: frontmatter other than \`description\` changed`);
    }
    const descBefore = fmBefore.entries.find(([k]) => k === "description");
    const descAfter = fmAfter.entries.find(([k]) => k === "description");
    if (descBefore && !descAfter) {
      problems.push(`${file}: \`description\` was removed`);
    } else if (descBefore && descAfter && descBefore[1] !== descAfter[1]) {
      if (!isRouter(file)) {
        problems.push(
          `${file}: workflow \`description\` must stay verbatim (CLAUDE.md); only router descriptions may change`,
        );
      } else if (descAfter[1].length > DESCRIPTION_LIMIT) {
        problems.push(
          `${file}: description is over ${DESCRIPTION_LIMIT} characters`,
        );
      }
    }
  }
  if (
    sectionHeadings(before).join("\n") !== sectionHeadings(after).join("\n")
  ) {
    problems.push(
      `${file}: \`##\` sections changed; extend existing sections instead`,
    );
  }
  const domainDir = path.join(
    skillsDir,
    path.dirname(file).replace(/\/references$/, ""),
  );
  for (const [, name] of after.matchAll(/references\/([a-z0-9-]+)\.md/g)) {
    if (!existsSync(path.join(domainDir, "references", `${name}.md`))) {
      problems.push(`${file}: links to missing references/${name}.md`);
    }
  }
  const patterns = file.includes("/references/")
    ? [...PHRASE_WARNINGS, ...REFERENCE_PHRASE_WARNINGS]
    : PHRASE_WARNINGS;
  for (const line of addedLines) {
    for (const [pattern, reason] of patterns) {
      if (pattern.test(line)) {
        warnings.push(`${file}: ${reason}: \`${line.trim().slice(0, 120)}\``);
      }
    }
  }
  return { problems, warnings };
}

// Line diff from the before and after text, so git attributes, filters, and
// ignore files in the checkout cannot hide or reshape it.
export function lineDiff(before, after) {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const x = a.slice(start, endA);
  const y = b.slice(start, endB);
  const lcs = Array.from(
    { length: x.length + 1 },
    () => new Uint16Array(y.length + 1),
  );
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      lcs[i][j] =
        x[i] === y[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const added = [];
  const removed = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) removed.push(x[i++]);
    else added.push(y[j++]);
  }
  removed.push(...x.slice(i));
  added.push(...y.slice(j));
  return { added, removed };
}

const blobHash = (content) =>
  createHash("sha1")
    .update(`blob ${content.length}\0`)
    .update(content)
    .digest("hex");

function workingTreeHashes(root) {
  const hashes = new Map();
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      const rel = path.relative(root, full);
      if (rel === ".git") continue;
      const stat = lstatSync(full);
      if (stat.isDirectory()) walk(full);
      else if (stat.isSymbolicLink()) {
        hashes.set(rel, blobHash(Buffer.from(readlinkSync(full))));
      } else hashes.set(rel, blobHash(readFileSync(full)));
    }
  };
  walk(root);
  return hashes;
}

function baseTreeHashes(skillsDir, baseSha) {
  const hashes = new Map();
  const listing = git(skillsDir, [
    "ls-tree",
    "-r",
    "-z",
    "--full-tree",
    baseSha,
  ]);
  for (const entry of listing.split("\0").filter(Boolean)) {
    const [meta, file] = entry.split("\t");
    const [mode, type, sha] = meta.split(" ");
    if (type === "blob") hashes.set(file, { sha, mode });
  }
  return hashes;
}

// Runs the trusted checker on the edited skills with the BASE_SHA skill files
// as the baseline. Any failure to produce a report rejects the edits.
function newBrokenReferences({ skillsDir, base, baseSha, checker, spec }) {
  const baseline = mkdtempSync(path.join(tmpdir(), "skills-baseline-"));
  try {
    for (const [file, { sha }] of base) {
      if (!/^skills\/.+\.md$/.test(file)) continue;
      mkdirSync(path.join(baseline, path.dirname(file)), { recursive: true });
      writeFileSync(
        path.join(baseline, file),
        git(skillsDir, ["cat-file", "blob", sha], { encoding: null }),
      );
    }
    let stdout;
    try {
      stdout = execFileSync(
        "node",
        [
          checker,
          "--skills",
          skillsDir,
          "--baseline-skills",
          baseline,
          "--spec",
          spec,
          "--json",
        ],
        { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
      );
    } catch (error) {
      return {
        error: `drift checker failed: ${String(error.stderr || error.message)
          .trim()
          .slice(0, 300)}`,
      };
    }
    const report = JSON.parse(stdout);
    if (!Array.isArray(report.introduced)) {
      return { error: "drift checker output has no `introduced` list" };
    }
    return { introduced: report.introduced };
  } catch (error) {
    return {
      error: `could not compare with ${baseSha}: ${error.message.slice(0, 300)}`,
    };
  } finally {
    rmSync(baseline, { recursive: true, force: true });
  }
}

export function findSecrets(text) {
  return SECRET_PATTERNS.filter((pattern) => pattern.test(text)).map(
    (pattern) => pattern.source.slice(0, 24),
  );
}

export function guardEdits({
  skillsDir,
  baseSha,
  checker,
  spec,
  notesFile = null,
}) {
  const problems = [];
  const warnings = [];
  const head = git(skillsDir, ["rev-parse", "HEAD"]).trim();
  const baseCommit = git(skillsDir, [
    "rev-parse",
    `${baseSha}^{commit}`,
  ]).trim();
  if (head !== baseCommit) {
    problems.push(
      "Commits were made during the run; edits must stay uncommitted",
    );
  }
  const base = baseTreeHashes(skillsDir, baseCommit);
  const work = workingTreeHashes(skillsDir);
  const changed = [];
  for (const [file, hash] of work) {
    const tracked = base.get(file);
    if (!tracked) {
      problems.push(`${file}: new files are not allowed`);
    } else if (tracked.sha !== hash) {
      if (/^skills\/.+\.md$/.test(file) && tracked.mode === "100644") {
        changed.push(file);
      } else {
        problems.push(
          `${file}: only existing skills/**/*.md files may be edited`,
        );
      }
    }
  }
  for (const file of base.keys()) {
    if (!work.has(file))
      problems.push(`${file}: deleting files is not allowed`);
  }
  changed.sort();

  let changedLines = 0;
  for (const file of changed) {
    const before = git(skillsDir, ["cat-file", "blob", base.get(file).sha]);
    const after = readFileSync(path.join(skillsDir, file), "utf8");
    const { added, removed } = lineDiff(before, after);
    changedLines += added.length + removed.length;
    const result = checkFile({
      file,
      before,
      after,
      addedLines: added,
      skillsDir,
    });
    problems.push(...result.problems);
    warnings.push(...result.warnings);
    for (const name of findSecrets(added.join("\n"))) {
      problems.push(`${file}: added text looks like a secret (${name})`);
    }
  }
  if (changed.length > MAX_FILES) {
    problems.push(`${changed.length} files changed; the limit is ${MAX_FILES}`);
  }
  if (changedLines > MAX_CHANGED_LINES) {
    problems.push(
      `${changedLines} lines changed; the limit is ${MAX_CHANGED_LINES}. Split the work or do it by hand.`,
    );
  }

  if (changed.length > 0) {
    const broken = newBrokenReferences({
      skillsDir,
      base,
      baseSha: baseCommit,
      checker,
      spec,
    });
    if (broken.error) problems.push(broken.error);
    for (const finding of broken.introduced ?? []) {
      const label =
        finding.method === "ANY"
          ? `/api${finding.path}`
          : `${finding.method} /api${finding.path}`;
      problems.push(
        `${finding.file}:${finding.line}: new reference to a ${finding.detail ? "missing" : "deprecated"} endpoint \`${label}\``,
      );
    }
  }
  if (notesFile) {
    const notes = readIfExists(notesFile);
    if (changed.length > 0 && !notes.trim()) {
      problems.push("Skills changed but the notes file is empty");
    }
    for (const name of findSecrets(notes)) {
      problems.push(`notes: text looks like a secret (${name})`);
    }
  }
  return { problems, warnings, changed, changedLines };
}

function guard() {
  const result = guardEdits({
    skillsDir: env("SKILLS_DIR"),
    baseSha: env("BASE_SHA"),
    checker: env("CHECKER"),
    spec: env("SPEC"),
    notesFile: process.env.NOTES_FILE || null,
  });
  const { problems, warnings, changed, changedLines } = result;
  const report = problems.length
    ? ["### Guard rejected the edits", "", ...problems.map((p) => `- ${p}`), ""]
    : [`### Guard passed (${changed.length} files, ${changedLines} lines)`, ""];
  if (warnings.length) {
    report.push(
      "#### Wording to check",
      "",
      ...warnings.map((w) => `- ${w}`),
      "",
    );
  }
  if (process.env.REPORT_FILE) {
    writeFileSync(process.env.REPORT_FILE, report.join("\n"));
  }
  if (process.env.RESULT_FILE) {
    writeFileSync(process.env.RESULT_FILE, JSON.stringify(result, null, 2));
  }
  process.stdout.write(report.join("\n") + "\n");
  if (problems.length) process.exit(1);
}

// Bare "#123" would link to this repo, so point GrowthBook PR numbers at
// growthbook/growthbook.
export function linkGrowthbookPrs(notes, prNumbers) {
  const known = new Set(prNumbers);
  return notes.replace(/(^|[^\w/])#(\d+)\b/g, (match, lead, n) =>
    known.has(Number(n)) ? `${lead}growthbook/growthbook#${n}` : match,
  );
}

export function buildSection({
  prs,
  notes,
  overlaps,
  paired,
  warnings,
  before,
  after,
  date,
}) {
  const linkedNotes = linkGrowthbookPrs(
    notes.trim(),
    prs.map((pr) => pr.number),
  );
  const actionable = linkedNotes.replace(
    /#### Checked, no change[\s\S]*?(?=\n#### |$)/,
    "",
  );
  const cited = prs.filter((pr) =>
    actionable.includes(`growthbook/growthbook#${pr.number}`),
  );
  const primary = cited.length ? cited : prs.length <= 3 ? prs : [];
  const rest = prs.filter((pr) => !primary.includes(pr));
  const line = (pr) => `- growthbook/growthbook#${pr.number} ${pr.title}`;
  const lines = [`### Sync ${date}`, ""];
  if (prs.length) {
    if (primary.length) lines.push("GrowthBook PRs:", ...primary.map(line), "");
    if (rest.length) {
      lines.push(
        `<details><summary>${primary.length ? "Also reviewed" : "GrowthBook PRs reviewed"} (${rest.length})</summary>`,
        "",
        ...rest.map(line),
        "",
        "</details>",
        "",
      );
    }
  } else {
    lines.push(
      `GrowthBook changes: https://github.com/growthbook/growthbook/compare/${before}...${after}`,
      "",
    );
  }
  lines.push(linkedNotes);
  if (warnings.length) {
    lines.push(
      "",
      "#### Wording to check",
      "",
      ...warnings.map((w) => `- ${w}`),
    );
  }
  if (paired.length) {
    lines.push(
      "",
      `Paired skills PRs: ${paired.map((p) => `growthbook/growthbook#${p.growthbook} → #${p.skills}`).join(", ")}.`,
    );
  }
  if (overlaps.length) {
    lines.push(
      "",
      `Also changed in other open PRs: ${overlaps
        .map(
          (pr) =>
            `#${pr.number} (${pr.files.map((f) => `\`${f}\``).join(", ")})`,
        )
        .join("; ")}.`,
    );
  }
  // The subject names only PRs behind an actual change, not open questions.
  const changesOnly =
    /#### Changes([\s\S]*?)(?=\n#### |$)/.exec(linkedNotes)?.[1] ?? "";
  const refs = prs
    .filter((pr) => changesOnly.includes(`growthbook/growthbook#${pr.number}`))
    .map((pr) => `growthbook/growthbook#${pr.number}`);
  const subject = refs.length
    ? `Sync skills with ${refs.slice(0, 3).join(", ")}${refs.length > 3 ? " and more" : ""}`
    : "Sync skills with GrowthBook API changes";
  return { body: `${lines.join("\n")}\n`, subject };
}

// Other open PRs that touch a file this run edited.
export function overlapsFor(openPrs, changed, ownNumber) {
  return openPrs
    .filter((pr) => pr.number !== ownNumber)
    .map((pr) => ({
      number: pr.number,
      files: (pr.files ?? [])
        .map((f) => f.path)
        .filter((f) => changed.includes(f)),
    }))
    .filter((pr) => pr.files.length > 0);
}

function section() {
  const syncDir = env("SYNC_DIR");
  const trusted = env("TRUSTED");
  const target = readJson(path.join(syncDir, "target.json"), {});
  const guardResult = readJson(path.join(trusted, "guard.json"), {});
  const { body, subject } = buildSection({
    prs: readJson(path.join(syncDir, "growthbook-prs.json"), []),
    notes: readFileSync(path.join(syncDir, "notes.md"), "utf8"),
    overlaps: overlapsFor(
      readJson(path.join(syncDir, "open-prs.json"), []),
      guardResult.changed ?? [],
      target.number,
    ),
    paired: target.paired ?? [],
    warnings: guardResult.warnings ?? [],
    before: env("BEFORE"),
    after: env("AFTER"),
    date: new Date().toISOString().slice(0, 10),
  });
  writeFileSync(path.join(syncDir, "section.md"), body);
  writeFileSync(
    path.join(syncDir, "commit-message.txt"),
    `${subject}\n\n${body}`,
  );
}

const SYNC_INTRO =
  "Draft from the GrowthBook sync job. Check each change against its cited source before merging.";
const TRIM_NOTE =
  "_Older sync sections were trimmed to fit; their notes are in the commit messages._";

// Keeps the intro and the newest sections under GitHub's description limit.
export function appendSection(existing, section, limit = BODY_LIMIT) {
  const base = existing.trim() || SYNC_INTRO;
  const parts = base.split(/\n(?=### Sync )/);
  let trimmed = parts[0].includes(TRIM_NOTE);
  const intro = parts[0].replace(`\n\n${TRIM_NOTE}`, "").trim();
  const sections = [...parts.slice(1).map((s) => s.trim()), section.trim()];
  const build = () =>
    [intro + (trimmed ? `\n\n${TRIM_NOTE}` : ""), ...sections].join("\n\n") +
    "\n";
  while (build().length > limit && sections.length > 1) {
    sections.shift();
    trimmed = true;
  }
  return build().slice(0, limit);
}

function body() {
  const syncDir = env("SYNC_DIR");
  const section = readFileSync(path.join(syncDir, "section.md"), "utf8");
  const existing =
    env("KIND") === "sync"
      ? readIfExists(path.join(syncDir, "current-body.md"))
      : "";
  writeFileSync(
    path.join(syncDir, "body.md"),
    appendSection(existing, section),
  );
}

export function questionsSection(notes) {
  const start = notes.search(/^#### Needs a human$/m);
  if (start === -1) return "";
  const rest = notes.slice(start);
  const next = rest.slice(1).search(/^#### /m);
  return (next === -1 ? rest : rest.slice(0, next + 1)).trim();
}

function questions() {
  const syncDir = env("SYNC_DIR");
  const trusted = env("TRUSTED");
  const prs = readJson(path.join(syncDir, "growthbook-prs.json"), []);
  const parts = [];
  const asked = questionsSection(readIfExists(path.join(syncDir, "notes.md")));
  if (asked)
    parts.push(
      linkGrowthbookPrs(
        asked,
        prs.map((pr) => pr.number),
      ),
    );
  const guardReport = readIfExists(path.join(trusted, "guard.md"));
  const before = env("BEFORE");
  const after = env("AFTER");
  if (process.env.GUARD_OUTCOME === "failure" && guardReport) {
    parts.push(
      "#### The guard rejected this run's edits",
      "",
      `Nothing was published, and this range counts as reviewed. Fix the skills by hand, or adjust the guard and re-run the workflow with \`since\` set to \`${before}\`.`,
      "",
      guardReport.replace(/^### /gm, "##### "),
    );
  }
  if (!parts.length) return;
  const header = `From the sync run for growthbook/growthbook ${before.slice(0, 10)}...${after.slice(0, 10)} (${process.env.RUN_URL ?? "this run"}).`;
  writeFileSync(
    path.join(syncDir, "questions-body.md"),
    [header, "", ...parts].join("\n\n").replace(/\n{3,}/g, "\n\n") + "\n",
  );
}

function main() {
  const [command] = process.argv.slice(2);
  if (command === "range") return range();
  if (command === "guard") return guard();
  const syncDir = env("SYNC_DIR");
  if (command === "prs") {
    const { prs, bySha } = collectPrs(
      readIfExists(path.join(syncDir, "commit-prs.jsonl")),
    );
    writeFileSync(
      path.join(syncDir, "growthbook-prs.json"),
      JSON.stringify(prs),
    );
    writeFileSync(path.join(syncDir, "commit-prs.json"), JSON.stringify(bySha));
    return process.stdout.write(
      prs.map((pr) => `#${pr.number} ${pr.title}`).join("\n") + "\n",
    );
  }
  if (command === "target") {
    const target = pickTarget({
      openPrs: readJson(path.join(syncDir, "open-prs.json"), []),
      growthbookPrs: readJson(path.join(syncDir, "growthbook-prs.json"), []),
      syncBranch: env("SYNC_BRANCH"),
    });
    writeFileSync(
      path.join(syncDir, "target.json"),
      JSON.stringify(target, null, 2),
    );
    return output({
      kind: target.kind,
      number: target.number,
      head_sha: target.headSha,
    });
  }
  if (command === "changes") return changes();
  if (command === "prompt") {
    const target = readJson(path.join(syncDir, "target.json"), {});
    const prs = readJson(path.join(syncDir, "growthbook-prs.json"), []);
    return process.stdout.write(
      renderPrompt(readFileSync(path.join(HERE, "prompt.md"), "utf8"), {
        BEFORE: env("BEFORE"),
        AFTER: env("AFTER"),
        GROWTHBOOK_PRS: prs.length
          ? prs
              .map((pr) => `- growthbook/growthbook#${pr.number} ${pr.title}`)
              .join("\n")
          : "- None found; review the commits in `.sync/changes/` directly.",
        TARGET: targetDescription(target),
        PAIRED: pairedDescription(target.paired ?? []),
        MAX_FILES: String(MAX_FILES),
        MAX_CHANGED_LINES: String(MAX_CHANGED_LINES),
      }),
    );
  }
  if (command === "section") return section();
  if (command === "body") return body();
  if (command === "questions") return questions();
  throw new Error(`Unknown command: ${command ?? "(none)"}`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  main();
}
