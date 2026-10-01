#!/usr/bin/env node
/**
 * Helpers for .github/workflows/sync-from-growthbook.yml.
 *
 *   last-sync    Find when this workflow last succeeded, from its run list.
 *   range        Resolve the GrowthBook commits to review since then.
 *   prs          Turn commit-to-PR lookups into the PR list and a commit map.
 *   pick-target  Choose the PR this run adds to.
 *   changes      Write each reviewed commit's diff for the model to read.
 *   prompt       Render prompt.md with this run's inputs.
 *   guard        Reject skill edits that break the authoring rules.
 *   section      Write the PR description section and commit message.
 *   body         Build the PR description or comment for the target.
 *
 * The workflow copies this directory, the GrowthBook drift checker, and the
 * spec to a trusted directory before the model runs, and runs every command
 * from there.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAX_CHANGED_LINES = 200;
const MAX_FILES = 8;
const DESCRIPTION_LIMIT = 1024;
const BODY_LIMIT = 60000;
const DIFF_LIMIT = 150000;
export const DRY_RUN_PREFIX = "Dry run";
const OVERLAP_MS = 60 * 60 * 1000;

// Each pattern is checked against added lines only. None of them matches the
// human-written skills, so a hit means the edit reads differently from the
// rest of the repo.
export const JUNK_PATTERNS = [
  [
    /growthbook\/(growthbook|skills)|\/pull\/\d+|\bskills#\d+|(^|[\s(])#\d{2,}\b/,
    "links to PRs or issues belong in the PR description, not the skill",
  ],
  [
    /\b(as of (v?\d|today|now|this)|(has|have) been (changed|updated|renamed|added|removed)|(was|were) (changed|renamed) (to|in)|newly added|recent (change|update)s?)\b/i,
    "changelog wording; describe current behavior only",
  ],
  [
    /(^|[.(]\s*|^\s*[-*]\s+)(Previously|Formerly)\b|\(previously\b|\bno longer (supported|available|accepted|returned|required|works?)\b/i,
    "changelog wording; describe current behavior only",
  ],
  [/\b(TODO|FIXME|XXX|TBD)\b/, "unfinished-work markers"],
  [/<!--/, "HTML comments"],
  [/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B50}\u{2705}\u{FE0F}]/u, "emoji"],
  [/\s+$/, "trailing whitespace"],
];

// Routers name the Claude Code plugin in their install preamble, which
// skills CLAUDE.md allows; workflow files stay client-neutral.
export const REFERENCE_ONLY_PATTERNS = [
  [
    /\b(Claude|Anthropic|OpenAI|ChatGPT|Cursor|LLM|as an AI)\b/,
    "provider names stay out of workflow files (CLAUDE.md: client-neutral core)",
  ],
];

function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

// Ignore repo hooks and fsmonitor so nothing in a checkout can run code.
function git(cwd, ...args) {
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
      encoding: "utf8",
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

export function parseGrowthbookPrs(tsv) {
  return tsv
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [number, title, linked = ""] = line.split("\t");
      return {
        number: Number(number),
        title,
        linkedSkillsPrs: linked.split(",").filter(Boolean).map(Number),
      };
    });
}

// Input lines are "sha<TAB>number<TAB>title<TAB>linked skills PRs".
export function collectPrs(tsv) {
  const byNumber = new Map();
  const bySha = {};
  for (const line of tsv.split("\n").filter(Boolean)) {
    const [sha, number, title, linked = ""] = line.split("\t");
    bySha[sha] = Number(number);
    byNumber.set(Number(number), { title, linked });
  }
  const list = [...byNumber]
    .sort(([a], [b]) => a - b)
    .map(([number, { title, linked }]) => `${number}\t${title}\t${linked}`);
  return { tsv: list.join("\n") + (list.length ? "\n" : ""), bySha };
}

export function watchPaths(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

// The window starts at the latest successful non-dry run, an hour early so a
// commit merged while that run was starting is reviewed again rather than
// skipped. Runs are newest first, as the Actions API lists them.
export function lastSyncTime(runs) {
  const run = runs.find(
    (r) =>
      r.conclusion === "success" &&
      !(r.display_title ?? "").startsWith(DRY_RUN_PREFIX),
  );
  if (!run) return null;
  return new Date(Date.parse(run.run_started_at) - OVERLAP_MS).toISOString();
}

function range() {
  const growthbookDir = env("GROWTHBOOK_DIR");
  const trusted = env("TRUSTED");
  const syncDir = env("SYNC_DIR");
  const after = git(growthbookDir, "rev-parse", "HEAD").trim();
  const since = process.env.LAST_SYNC || "7 days ago";
  let before = process.env.SINCE || "";
  if (!before) {
    before = git(
      growthbookDir,
      "rev-list",
      "-1",
      `--before=${since}`,
      after,
    ).trim();
  }
  let isAncestor = false;
  try {
    git(growthbookDir, "merge-base", "--is-ancestor", before, after);
    isAncestor = /^[0-9a-f]{7,40}$/.test(before);
  } catch {
    isAncestor = false;
  }
  if (!isAncestor) {
    throw new Error(
      `Cannot review from "${before}": not an ancestor of ${after}`,
    );
  }
  const paths = watchPaths(
    readFileSync(path.join(trusted, "watch-paths.txt"), "utf8"),
  );
  const commits = git(
    growthbookDir,
    "log",
    "--format=%H",
    `${before}..${after}`,
    "--",
    ...paths,
  )
    .split("\n")
    .filter(Boolean);
  writeFileSync(
    path.join(syncDir, "commits.txt"),
    commits.join("\n") + (commits.length ? "\n" : ""),
  );
  writeFileSync(
    path.join(trusted, "base-spec.yaml"),
    git(
      growthbookDir,
      "show",
      `${before}:packages/back-end/generated/spec.yaml`,
    ),
  );
  output({ before, after, commits: commits.length });
}

// A skills PR is paired with a GrowthBook PR when it names that PR, or the
// GrowthBook PR links it. Edits go to a paired PR only when the run covers
// that one GrowthBook PR alone; otherwise they would carry unrelated fixes.
export function pickTarget({ openPrs, growthbookPrs, affected, syncBranch }) {
  const sameRepo = openPrs.filter((pr) => !pr.isCrossRepository);
  const filesOf = (pr) => (pr.files ?? []).map((f) => f.path);
  const paired = [];
  for (const gb of growthbookPrs) {
    const mention = new RegExp(
      `growthbook/growthbook(#|/pull/)${gb.number}\\b`,
    );
    for (const pr of sameRepo) {
      if (pr.headRefName === syncBranch) continue;
      if (
        gb.linkedSkillsPrs.includes(pr.number) ||
        mention.test(pr.body ?? "")
      ) {
        paired.push({
          growthbook: gb.number,
          skills: pr.number,
          branch: pr.headRefName,
        });
      }
    }
  }
  const syncPr = sameRepo.find((pr) => pr.headRefName === syncBranch);
  let target;
  if (growthbookPrs.length === 1 && paired.length === 1) {
    const pr = sameRepo.find((p) => p.number === paired[0].skills);
    target = {
      kind: "related",
      number: pr.number,
      branch: pr.headRefName,
      files: filesOf(pr),
    };
  } else if (syncPr) {
    target = {
      kind: "sync",
      number: syncPr.number,
      branch: syncBranch,
      files: filesOf(syncPr),
    };
  } else {
    target = { kind: "new", number: null, branch: syncBranch, files: [] };
  }
  const overlaps = sameRepo
    .filter((pr) => pr.number !== target.number)
    .map((pr) => ({
      number: pr.number,
      files: filesOf(pr).filter((f) => affected.includes(f)),
    }))
    .filter((pr) => pr.files.length > 0);
  return {
    ...target,
    paired: target.kind === "related" ? [] : paired,
    overlaps,
  };
}

export function affectedSkillFiles(report) {
  return [
    ...new Set([
      ...report.impacted.flatMap((i) => i.files),
      ...report.missing.map((f) => f.file),
      ...report.deprecated.map((f) => f.file),
    ]),
  ].sort();
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
    let diff = git(
      growthbookDir,
      "show",
      "--stat",
      "--patch",
      "--format=commit %H%nDate: %as%n%n%B",
      sha,
      "--",
      ...paths,
    );
    if (diff.length > DIFF_LIMIT) {
      diff = `${diff.slice(0, DIFF_LIMIT)}\n\n[Truncated at ${DIFF_LIMIT} characters. The rest of this commit is not shown.]\n`;
    }
    writeFileSync(path.join(dir, file), diff);
    const subject = git(growthbookDir, "log", "-1", "--format=%s", sha).trim();
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
    return "No open PR covers this yet. Your edits start a new draft PR from `main`.";
  }
  const files = target.files.map((f) => `\`${f}\``).join(", ") || "nothing yet";
  return `Your edits are added to open PR #${target.number} (branch \`${target.branch}\`), which is checked out. It already changes: ${files}. Build on its changes; don't redo or undo them.`;
}

export function pairedDescription(paired) {
  if (!paired.length) return "None.";
  return paired
    .map(
      (p) =>
        `- growthbook/growthbook#${p.growthbook} is paired with skills PR #${p.skills}. Leave skill changes caused by that GrowthBook PR to #${p.skills}; list them under "Checked, no change" as covered by #${p.skills}.`,
    )
    .join("\n");
}

// Frontmatter as an ordered list of [key, raw value including continuation
// lines], so any change outside `description` is visible.
export function frontmatterEntries(text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) return null;
  const entries = [];
  for (const line of match[1].split("\n")) {
    const key = /^([A-Za-z0-9_-]+):(.*)$/.exec(line);
    if (key) entries.push([key[1], key[2].trim()]);
    else if (entries.length) entries[entries.length - 1][1] += `\n${line}`;
    else entries.push(["", line]);
  }
  return entries;
}

function scalarText(raw) {
  const [first, ...rest] = raw.split("\n");
  if (/^[>|][+-]?$/.test(first.trim())) {
    return rest
      .map((l) => l.trim())
      .join(" ")
      .trim();
  }
  return raw.replace(/^["']|["']$/g, "").trim();
}

const sectionHeadings = (text) =>
  text
    .split("\n")
    .filter((line) => /^## /.test(line) && line !== "## Contents");

export function checkFile({ file, before, after, addedLines, skillsDir }) {
  const problems = [];
  const fmBefore = frontmatterEntries(before);
  const fmAfter = frontmatterEntries(after);
  if (!fmAfter) {
    problems.push(`${file}: frontmatter is missing or malformed`);
  } else {
    const rest = (entries) =>
      JSON.stringify((entries ?? []).filter(([key]) => key !== "description"));
    if (fmBefore && rest(fmBefore) !== rest(fmAfter)) {
      problems.push(`${file}: frontmatter other than \`description\` changed`);
    }
    const description = fmAfter.find(([key]) => key === "description");
    if (description && scalarText(description[1]).length > DESCRIPTION_LIMIT) {
      problems.push(
        `${file}: description is over ${DESCRIPTION_LIMIT} characters`,
      );
    }
  }
  if (
    sectionHeadings(before).join("\n") !== sectionHeadings(after).join("\n")
  ) {
    problems.push(
      `${file}: \`##\` sections changed; extend existing sections instead`,
    );
  }
  const patterns = file.includes("/references/")
    ? [...JUNK_PATTERNS, ...REFERENCE_ONLY_PATTERNS]
    : JUNK_PATTERNS;
  for (const line of addedLines) {
    for (const [pattern, reason] of patterns) {
      if (pattern.test(line)) {
        problems.push(`${file}: ${reason}: \`${line.trim().slice(0, 120)}\``);
      }
    }
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
  return problems;
}

// Runs the trusted checker on the edited skills with the BASE_SHA skills as
// the baseline. Any failure to produce a report rejects the edits.
function newBrokenReferences({ skillsDir, baseSha, checker, spec }) {
  const baseline = mkdtempSync(path.join(tmpdir(), "skills-baseline-"));
  try {
    const archive = execFileSync(
      "git",
      [
        "-c",
        "core.fsmonitor=false",
        "-C",
        skillsDir,
        "archive",
        baseSha,
        "skills",
      ],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    execFileSync("tar", ["-x", "-C", baseline], { input: archive });
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

export function guardEdits({
  skillsDir,
  baseSha,
  checker,
  spec,
  notesFile = null,
}) {
  const problems = [];
  if (
    git(skillsDir, "rev-parse", "HEAD").trim() !==
    git(skillsDir, "rev-parse", `${baseSha}^{commit}`).trim()
  ) {
    problems.push(
      "Commits were made during the run; edits must stay uncommitted",
    );
  }
  const changed = [];
  for (const entry of git(
    skillsDir,
    "status",
    "--porcelain",
    "--untracked-files=all",
  )
    .split("\n")
    .filter(Boolean)) {
    const code = entry.slice(0, 2).trim();
    const file = entry.slice(3);
    if (code !== "M" || !/^skills\/.+\.md$/.test(file)) {
      problems.push(
        `${file}: only edits to existing skills/**/*.md files are allowed (${code})`,
      );
    } else {
      changed.push(file);
    }
  }

  let changedLines = 0;
  for (const file of changed) {
    const lines = git(
      skillsDir,
      "diff",
      "--unified=0",
      baseSha,
      "--",
      file,
    ).split("\n");
    changedLines += lines.filter(
      (l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l),
    ).length;
    problems.push(
      ...checkFile({
        file,
        before: git(skillsDir, "show", `${baseSha}:${file}`),
        after: readFileSync(path.join(skillsDir, file), "utf8"),
        addedLines: lines
          .filter((l) => l.startsWith("+") && !l.startsWith("+++ "))
          .map((l) => l.slice(1)),
        skillsDir,
      }),
    );
  }
  if (changed.length > MAX_FILES) {
    problems.push(`${changed.length} files changed; the limit is ${MAX_FILES}`);
  }
  if (changedLines > MAX_CHANGED_LINES) {
    problems.push(
      `${changedLines} lines changed; the limit is ${MAX_CHANGED_LINES}. Split the work or do it by hand.`,
    );
  }

  const broken = newBrokenReferences({ skillsDir, baseSha, checker, spec });
  if (broken.error) problems.push(broken.error);
  for (const finding of broken.introduced ?? []) {
    problems.push(
      `${finding.file}:${finding.line}: new reference to a ${finding.detail ? "missing" : "deprecated"} endpoint \`${finding.method} /api${finding.path}\``,
    );
  }
  if (notesFile && changed.length > 0 && !readIfExists(notesFile).trim()) {
    problems.push("Skills changed but the notes file is empty");
  }
  return { problems, changed, changedLines };
}

function guard() {
  const { problems, changed, changedLines } = guardEdits({
    skillsDir: env("SKILLS_DIR"),
    baseSha: env("BASE_SHA"),
    checker: env("CHECKER"),
    spec: env("SPEC"),
    notesFile: process.env.NOTES_FILE || null,
  });
  const report = problems.length
    ? ["### Guard rejected the edits", "", ...problems.map((p) => `- ${p}`), ""]
    : [`### Guard passed (${changed.length} files, ${changedLines} lines)`, ""];
  if (process.env.REPORT_FILE)
    writeFileSync(process.env.REPORT_FILE, report.join("\n"));
  process.stdout.write(report.join("\n") + "\n");
  if (problems.length) process.exit(1);
}

// Bare "#123" in the notes would link to this repo, so point GrowthBook PR
// numbers at growthbook/growthbook.
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

function section() {
  const syncDir = env("SYNC_DIR");
  const target = readJson(path.join(syncDir, "target.json"), {});
  const { body, subject } = buildSection({
    prs: parseGrowthbookPrs(
      readIfExists(path.join(syncDir, "growthbook-prs.tsv")),
    ),
    notes: readFileSync(path.join(syncDir, "notes.md"), "utf8"),
    overlaps: target.overlaps ?? [],
    paired: target.paired ?? [],
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
  const intro = parts[0].replace(`\n\n${TRIM_NOTE}`, "");
  const sections = [...parts.slice(1).map((s) => s.trim()), section.trim()];
  let trimmed = false;
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
  const kind = env("KIND");
  const section = readFileSync(path.join(syncDir, "section.md"), "utf8");
  let text;
  if (kind === "new") text = appendSection("", section);
  else if (kind === "sync")
    text = appendSection(
      readIfExists(path.join(syncDir, "current-body.md")),
      section,
    );
  else {
    text =
      `The GrowthBook sync job added a commit to this PR because it is paired with the GrowthBook PR below.\n\n${section}`.slice(
        0,
        BODY_LIMIT,
      );
  }
  writeFileSync(path.join(syncDir, "body.md"), text);
}

function main() {
  const [command] = process.argv.slice(2);
  if (command === "range") return range();
  if (command === "guard") return guard();
  if (command === "last-sync") {
    const [, file] = process.argv.slice(2);
    const runs = JSON.parse(readFileSync(file, "utf8"));
    return output({ last_sync: lastSyncTime(runs.workflow_runs ?? runs) });
  }
  const syncDir = env("SYNC_DIR");
  if (command === "pick-target") {
    const report = readJson(path.join(syncDir, "drift-main.json"), null);
    const target = pickTarget({
      openPrs: readJson(path.join(syncDir, "open-prs.json"), []),
      growthbookPrs: parseGrowthbookPrs(
        readIfExists(path.join(syncDir, "growthbook-prs.tsv")),
      ),
      affected: report ? affectedSkillFiles(report) : [],
      syncBranch: env("SYNC_BRANCH"),
    });
    writeFileSync(
      path.join(syncDir, "target.json"),
      JSON.stringify(target, null, 2),
    );
    return output({
      kind: target.kind,
      number: target.number,
      branch: target.branch,
    });
  }
  if (command === "changes") return changes();
  if (command === "prs") {
    const { tsv, bySha } = collectPrs(
      readIfExists(path.join(syncDir, "commit-prs.tsv")),
    );
    writeFileSync(path.join(syncDir, "growthbook-prs.tsv"), tsv);
    writeFileSync(path.join(syncDir, "commit-prs.json"), JSON.stringify(bySha));
    return process.stdout.write(tsv);
  }
  if (command === "prompt") {
    const target = readJson(path.join(syncDir, "target.json"), {});
    const prs = parseGrowthbookPrs(
      readIfExists(path.join(syncDir, "growthbook-prs.tsv")),
    );
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
      }),
    );
  }
  if (command === "section") return section();
  if (command === "body") return body();
  throw new Error(`Unknown command: ${command ?? "(none)"}`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  main();
}
