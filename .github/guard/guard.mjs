#!/usr/bin/env node
/**
 * Check a change to this repo against the skill authoring rules.
 *
 *   node .github/guard/guard.mjs --repo <checkout> --base <commit> --head <commit>
 *     --checker <growthbook>/scripts/check-agent-skills-drift.mjs
 *     --spec <growthbook>/packages/back-end/generated/spec.yaml
 *     [--strict] [--pr-body <file>] [--report <file>]
 *
 * Every change: skill frontmatter must parse, router descriptions fit, links
 * to references/*.md resolve, no new reference to a missing or deprecated
 * endpoint, and no added text that looks like a secret.
 *
 * --strict (automated sync PRs) also allows only edits to existing
 * skills/**\/*.md files, no new `##` sections, no frontmatter change other
 * than a router description, a note tagging the head of data science in the
 * PR description when an experiment skill changes, at most one
 * new workflow shaped like its siblings, and a warning (or, past the hard
 * limits, a rejection) for large changes.
 *
 * Wording that reads like a changelog or chat is reported as a warning.
 * Commits are read with git plumbing (ls-tree, cat-file), so attributes,
 * filters, and ignore files in the change cannot hide anything.
 */

import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Sync PRs past the soft limits get a warning suggesting a split; past the
// hard limits the edit is treated as runaway and rejected.
export const SOFT_FILES = 8;
export const SOFT_LINES = 200;
export const SOFT_NEW_WORKFLOW_LINES = 250;
export const HARD_FILES = 25;
export const HARD_LINES = 1000;
const WORKFLOW_SECTIONS = [
  "## Workflow",
  "## Guardrails",
  "## Endpoints used",
  "## Handoffs",
];
const DESCRIPTION_LIMIT = 1024;
export const VOICE_AUTHORITY_REVIEWER = "lukesonnet";
const EXPERIMENTS_DIR = "skills/experiments/";

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

// Routers name the Claude Code plugin in their install preamble, which
// CLAUDE.md allows; workflow files stay client-neutral.
export const REFERENCE_PHRASE_WARNINGS = [
  [/\b(Claude|Anthropic|OpenAI|ChatGPT|as an AI)\b/, "provider name"],
];

const SECRET_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/,
  /\bsk-[A-Za-z0-9]{32,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
];

// Known key formats, plus opaque strings that look like an encoded key: 32+
// characters mixing upper case, lower case, and digits, or 40+ hex digits.
// Nothing in the human-written skills matches either.
export function findSecrets(text) {
  const found = SECRET_PATTERNS.filter((p) => p.test(text)).map(
    (p) => `matches ${p.source.slice(0, 20)}`,
  );
  for (const [token] of text.matchAll(/[A-Za-z0-9+/=_-]{32,}/g)) {
    if (/[A-Z]/.test(token) && /[a-z]/.test(token) && /[0-9]/.test(token)) {
      found.push("long mixed-case token");
      break;
    }
  }
  for (const [token] of text.matchAll(/\b[0-9a-f]{40,}\b/g)) {
    if (/[0-9]/.test(token) && /[a-f]/.test(token)) {
      found.push("long hex string");
      break;
    }
  }
  return found;
}

function git(repo, args, encoding = "utf8") {
  return execFileSync(
    "git",
    ["-c", "core.fsmonitor=false", "-C", repo, ...args],
    {
      encoding,
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    },
  );
}

function tree(repo, commit) {
  const files = new Map();
  const listing = git(repo, ["ls-tree", "-r", "-z", "--full-tree", commit]);
  for (const entry of listing.split("\0").filter(Boolean)) {
    const [meta, file] = entry.split("\t");
    const [mode, type, sha] = meta.split(" ");
    if (type === "blob") files.set(file, { mode, sha });
  }
  return files;
}

const blob = (repo, sha) => git(repo, ["cat-file", "blob", sha]);
const isText = (text) => !text.includes("\0");

// One `key: value` per line, as every skill in this repo is. Anything else
// (block scalars, continuation lines, unquoted values with ": " or " #") is a
// parse error or a hidden extra key in YAML.
export function parseFrontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) return { error: "frontmatter is missing or malformed" };
  const entries = [];
  for (const line of match[1].split("\n")) {
    const kv = /^([A-Za-z0-9_-]+): (.*)$/.exec(line);
    if (!kv) {
      return { error: `frontmatter line is not \`key: value\`: \`${line}\`` };
    }
    const quoted = /^(["']).*\1$/.test(kv[2]);
    if (!quoted && (/: /.test(kv[2]) || / #/.test(kv[2]))) {
      return {
        error: `frontmatter \`${kv[1]}\` needs quotes: it contains ": " or " #"`,
      };
    }
    entries.push([kv[1], kv[2]]);
  }
  return { entries };
}

const isRouter = (file) => /^skills\/[^/]+\/SKILL\.md$/.test(file);
const isSkillFile = (file) => /^skills\/.+\.md$/.test(file);
const sectionHeadings = (text) =>
  text
    .split("\n")
    .filter((line) => /^## /.test(line) && line !== "## Contents");

// Line diff from the two texts, trimming the common prefix and suffix so the
// LCS only spans the changed region.
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
  if (x.length * y.length > 25_000_000) {
    return { added: y, removed: x };
  }
  const lcs = Array.from(
    { length: x.length + 1 },
    () => new Uint32Array(y.length + 1),
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

export function checkSkillFile({
  file,
  before,
  after,
  addedLines,
  headFiles,
  strict,
}) {
  const problems = [];
  const warnings = [];
  const fmAfter = parseFrontmatter(after);
  if (fmAfter.error) {
    problems.push(`${file}: ${fmAfter.error}`);
  } else {
    const description = fmAfter.entries.find(([k]) => k === "description");
    if (!description) problems.push(`${file}: \`description\` is missing`);
    else if (isRouter(file) && description[1].length > DESCRIPTION_LIMIT) {
      problems.push(
        `${file}: description is over ${DESCRIPTION_LIMIT} characters`,
      );
    }
  }
  if (strict && before !== null) {
    const fmBefore = parseFrontmatter(before);
    if (!fmBefore.error && !fmAfter.error) {
      const without = (entries) =>
        JSON.stringify(entries.filter(([key]) => key !== "description"));
      if (without(fmBefore.entries) !== without(fmAfter.entries)) {
        problems.push(
          `${file}: frontmatter other than \`description\` changed`,
        );
      }
      const d0 = fmBefore.entries.find(([k]) => k === "description")?.[1];
      const d1 = fmAfter.entries.find(([k]) => k === "description")?.[1];
      if (d0 !== d1 && !isRouter(file)) {
        problems.push(
          `${file}: workflow \`description\` must stay verbatim; only router descriptions may change`,
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
  }
  const domain = path.posix.dirname(file).replace(/\/references$/, "");
  for (const [, name] of after.matchAll(/references\/([a-z0-9-]+)\.md/g)) {
    if (!headFiles.has(`${domain}/references/${name}.md`)) {
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

function writeSkills(repo, files, dir) {
  for (const [file, { sha }] of files) {
    if (!isSkillFile(file)) continue;
    mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
    writeFileSync(
      path.join(dir, file),
      git(repo, ["cat-file", "blob", sha], null),
    );
  }
}

// Runs the drift checker on the head skills with the base skills as the
// baseline. Any failure to produce a report is a problem, never a pass.
function newBrokenReferences({ repo, base, head, checker, spec }) {
  const work = mkdtempSync(path.join(tmpdir(), "skills-guard-"));
  try {
    writeSkills(repo, base, path.join(work, "base"));
    writeSkills(repo, head, path.join(work, "head"));
    mkdirSync(path.join(work, "base", "skills"), { recursive: true });
    mkdirSync(path.join(work, "head", "skills"), { recursive: true });
    let stdout;
    try {
      stdout = execFileSync(
        "node",
        [
          checker,
          "--skills",
          path.join(work, "head"),
          "--baseline-skills",
          path.join(work, "base"),
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
      error: `could not run the drift check: ${error.message.slice(0, 300)}`,
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const routerFor = (file) => file.replace(/\/references\/[^/]+$/, "/SKILL.md");

function isNewWorkflowPath(file, base) {
  const match = /^skills\/([a-z0-9-]+)\/references\/[a-z0-9-]+\.md$/.exec(file);
  return Boolean(match) && base.has(`skills/${match[1]}/SKILL.md`);
}

// A new workflow must have the shape every existing one shares, and its
// domain router must list it.
export function checkNewWorkflow({ file, text, router }) {
  const problems = [];
  const name = path.posix.basename(file, ".md");
  const fm = parseFrontmatter(text);
  if (!fm.error && fm.entries.find(([k]) => k === "name")?.[1] !== name) {
    problems.push(`${file}: frontmatter \`name\` must be \`${name}\``);
  }
  const lines = text.split("\n").length;
  const headings = text.split("\n").filter((l) => /^## /.test(l));
  let at = -1;
  for (const section of WORKFLOW_SECTIONS) {
    const next = headings.indexOf(section);
    if (next === -1 || next < at) {
      problems.push(
        `${file}: needs ${WORKFLOW_SECTIONS.map((s) => `\`${s}\``).join(", ")} in that order`,
      );
      break;
    }
    at = next;
  }
  if (lines > 100 && headings[0] !== "## Contents") {
    problems.push(
      `${file}: over 100 lines, so it needs a \`## Contents\` index first`,
    );
  }
  if (!/^# /m.test(text)) problems.push(`${file}: needs a \`# ${name}\` title`);
  if (!router.includes(`references/${name}.md`)) {
    problems.push(
      `${routerFor(file)}: must list \`references/${name}.md\` in its workflow table`,
    );
  }
  return problems;
}

export function guard({
  repo,
  baseSha,
  headSha,
  checker,
  spec,
  strict,
  prBody = "",
}) {
  const problems = [];
  const warnings = [];
  const base = tree(repo, baseSha);
  const head = tree(repo, headSha);
  const changed = [];
  for (const [file, entry] of head) {
    const before = base.get(file);
    if (!before) {
      if (strict && !isNewWorkflowPath(file, base)) {
        problems.push(
          `${file}: sync PRs may only add a workflow at skills/<existing domain>/references/<name>.md`,
        );
      }
      changed.push({ file, before: null, entry });
    } else if (before.sha !== entry.sha || before.mode !== entry.mode) {
      if (
        strict &&
        !(
          isSkillFile(file) &&
          entry.mode === "100644" &&
          before.mode === "100644"
        )
      ) {
        problems.push(
          `${file}: sync PRs may only edit existing skills/**/*.md files`,
        );
      }
      changed.push({ file, before, entry });
    }
  }
  for (const file of base.keys()) {
    if (!head.has(file) && strict) {
      problems.push(`${file}: deleting files is not allowed in sync PRs`);
    }
  }

  let changedLines = 0;
  const editedSkills = [];
  const newWorkflows = [];
  for (const { file, before, entry } of changed) {
    if (entry.mode === "120000" || entry.mode === "160000") continue;
    const after = blob(repo, entry.sha);
    const old =
      before && before.mode !== "120000" ? blob(repo, before.sha) : "";
    if (!isText(after)) continue;
    const { added, removed } = lineDiff(old, after);
    for (const finding of findSecrets(added.join("\n"))) {
      problems.push(`${file}: added text looks like a secret (${finding})`);
    }
    if (!isSkillFile(file)) continue;
    if (!before) {
      newWorkflows.push(file);
      if (strict) {
        problems.push(
          ...checkNewWorkflow({
            file,
            text: after,
            router: head.has(routerFor(file))
              ? blob(repo, head.get(routerFor(file)).sha)
              : "",
          }),
        );
      }
    } else {
      editedSkills.push(file);
      changedLines += added.length + removed.length;
    }
    if (
      strict &&
      file.startsWith(EXPERIMENTS_DIR) &&
      !new RegExp(`@${VOICE_AUTHORITY_REVIEWER}\\b`, "i").test(prBody)
    ) {
      problems.push(
        `${file}: experiment skills need review from GrowthBook's head of data science; the PR description must say it needs review from @${VOICE_AUTHORITY_REVIEWER}, and the PR stays a draft until he approves`,
      );
    }
    const result = checkSkillFile({
      file,
      before: before ? old : null,
      after,
      addedLines: added,
      headFiles: head,
      strict,
    });
    problems.push(...result.problems);
    warnings.push(...result.warnings);
  }
  if (strict && newWorkflows.length > 1) {
    problems.push(
      `${newWorkflows.length} new workflow files; sync PRs may add at most one`,
    );
  }
  if (strict) {
    const files = editedSkills.length + newWorkflows.length;
    const newLines = newWorkflows.reduce(
      (sum, file) => sum + blob(repo, head.get(file).sha).split("\n").length,
      0,
    );
    if (files > HARD_FILES || changedLines + newLines > HARD_LINES) {
      problems.push(
        `${files} skill files and ${changedLines + newLines} lines changed; past ${HARD_FILES} files or ${HARD_LINES} lines a sync PR is rejected. Split it.`,
      );
    } else if (files > SOFT_FILES || changedLines > SOFT_LINES) {
      warnings.push(
        `Large sync PR (${files} skill files, ${changedLines} lines edited): consider splitting it by topic`,
      );
    }
    for (const file of newWorkflows) {
      const lines = blob(repo, head.get(file).sha).split("\n").length;
      if (lines > SOFT_NEW_WORKFLOW_LINES) {
        warnings.push(
          `${file}: new workflow is ${lines} lines; consider a smaller first version`,
        );
      }
    }
  }
  if (editedSkills.length + newWorkflows.length > 0) {
    const broken = newBrokenReferences({ repo, base, head, checker, spec });
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
  return { problems, warnings, editedSkills, newWorkflows, changedLines };
}

function parseArgs(argv) {
  const args = { strict: false };
  const valued = [
    "--pr-body",
    "--repo",
    "--base",
    "--head",
    "--checker",
    "--spec",
    "--report",
  ];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--strict") args.strict = true;
    else if (valued.includes(argv[i]) && argv[i + 1])
      args[argv[i++].slice(2)] = argv[i];
    else throw new Error(`Unknown or incomplete argument: ${argv[i]}`);
  }
  for (const name of ["repo", "base", "head", "checker", "spec"]) {
    if (!args[name]) throw new Error(`--${name} is required`);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = guard({
    repo: args.repo,
    baseSha: args.base,
    headSha: args.head,
    checker: path.resolve(args.checker),
    spec: path.resolve(args.spec),
    strict: args.strict,
    prBody: args["pr-body"] ? readFileSync(args["pr-body"], "utf8") : "",
  });
  const mode = args.strict ? "sync PR rules" : "standard rules";
  const lines = result.problems.length
    ? [
        `### Skills guard: ${result.problems.length} problem(s) (${mode})`,
        "",
        ...result.problems.map((p) => `- ${p}`),
      ]
    : [
        `### Skills guard passed (${mode}; ${result.editedSkills.length} skill files, ${result.changedLines} lines${result.newWorkflows.length ? `, new workflow ${result.newWorkflows.join(", ")}` : ""})`,
      ];
  if (result.warnings.length) {
    lines.push(
      "",
      "#### Wording to check",
      "",
      ...result.warnings.map((w) => `- ${w}`),
    );
  }
  const report = lines.join("\n") + "\n";
  process.stdout.write(report);
  if (args.report) appendFileSync(args.report, report);
  if (process.env.GITHUB_ACTIONS) {
    for (const p of result.problems)
      process.stdout.write(`::error::${p.replace(/\n/g, " ")}\n`);
    for (const w of result.warnings)
      process.stdout.write(`::warning::${w.replace(/\n/g, " ")}\n`);
  }
  if (result.problems.length) process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  main();
}
