#!/usr/bin/env node
/**
 * Helpers for .github/workflows/sync-from-growthbook.yml.
 *
 *   pick-target  Choose the open PR this run adds to, or a new sync branch.
 *   prompt       Render prompt.md with this run's inputs.
 *   guard        Reject skill edits that break the authoring rules.
 *   section      Write the PR description section for this run.
 *
 * Reads SYNC_DIR, SKILLS_DIR, GROWTHBOOK_DIR, BEFORE, AFTER and SYNC_BRANCH
 * from the environment.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAX_CHANGED_LINES = 200;
const MAX_FILES = 8;
const DESCRIPTION_LIMIT = 1024;

// Each pattern is checked against added lines only. Every one of them has
// zero matches in the human-written skills, so a hit means the edit reads
// differently from the rest of the repo.
// Routers may name a client in their install preamble; workflow files may not.
export const REFERENCE_ONLY_PATTERNS = [
  [
    /\b(Claude|Anthropic|OpenAI|ChatGPT|Cursor|LLM|as an AI)\b/,
    "provider names stay out of workflow files (CLAUDE.md: client-neutral core)",
  ],
];

export const JUNK_PATTERNS = [
  [
    /growthbook\/growthbook|\/pull\/\d+|(^|[\s(])#\d{2,}\b/,
    "links to PRs or issues belong in the PR description, not the skill",
  ],
  [
    /\b(as of (v?\d|today|now|this)|(has|have) been (changed|updated|renamed|added|removed)|(was|were) (changed|renamed) (to|in)|newly added|recent (change|update)s?)\b/i,
    "changelog wording; describe current behavior only",
  ],
  [/\b(TODO|FIXME|XXX|TBD)\b/, "unfinished-work markers"],
  [/<!--/, "HTML comments"],
  [/[\u{1F300}-\u{1FAFF}\u{2700}-\u{27BF}\u{2B50}\u{2705}]/u, "emoji"],
  [/\s+$/, "trailing whitespace"],
];

function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

function readIfExists(file) {
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

function growthbookPrs(syncDir) {
  return readIfExists(path.join(syncDir, "growthbook-prs.tsv"))
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

export function affectedSkillFiles(driftReport) {
  return [
    ...new Set(
      [...driftReport.matchAll(/`(skills\/[^`:]+\.md)(?::\d+)?`/g)].map(
        (m) => m[1],
      ),
    ),
  ].sort();
}

// A PR is related only through an explicit link: it names one of this run's
// GrowthBook PRs, or one of those PRs links it. Sharing files is not enough;
// those PRs are listed for the reviewer instead.
export function pickTarget({ openPrs, growthbookPrs, affected, syncBranch }) {
  const linked = new Set(growthbookPrs.flatMap((pr) => pr.linkedSkillsPrs));
  const mentions = (body) =>
    growthbookPrs.some((pr) =>
      new RegExp(`growthbook/growthbook(#|/pull/)${pr.number}\\b`).test(
        body ?? "",
      ),
    );
  const sameRepo = openPrs.filter((pr) => !pr.isCrossRepository);
  const filesOf = (pr) => (pr.files ?? []).map((f) => f.path);
  const related = sameRepo.find(
    (pr) =>
      pr.headRefName !== syncBranch &&
      (linked.has(pr.number) || mentions(pr.body)),
  );
  const syncPr = sameRepo.find((pr) => pr.headRefName === syncBranch);
  const target = related
    ? {
        kind: "related",
        number: related.number,
        branch: related.headRefName,
        files: filesOf(related),
      }
    : syncPr
      ? {
          kind: "sync",
          number: syncPr.number,
          branch: syncBranch,
          files: filesOf(syncPr),
        }
      : { kind: "new", number: null, branch: syncBranch, files: [] };
  const overlaps = sameRepo
    .filter((pr) => pr.number !== target.number)
    .map((pr) => ({
      number: pr.number,
      files: filesOf(pr).filter((f) => affected.includes(f)),
    }))
    .filter((pr) => pr.files.length > 0);
  return { ...target, overlaps };
}

export function renderPrompt(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    if (!(key in values)) throw new Error(`Unknown placeholder ${match}`);
    return values[key];
  });
}

function frontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) return null;
  const field = (name) =>
    new RegExp(`^${name}:\\s*(.*)$`, "m").exec(match[1])?.[1]?.trim() ?? null;
  return { name: field("name"), description: field("description") };
}

const sectionHeadings = (text) =>
  text.split("\n").filter((line) => /^## /.test(line));

export function checkFile({ file, before, after, addedLines, skillsDir }) {
  const problems = [];
  const fmBefore = frontmatter(before);
  const fmAfter = frontmatter(after);
  if (!fmAfter) {
    problems.push(`${file}: frontmatter is missing or malformed`);
  } else {
    if (fmBefore && fmAfter.name !== fmBefore.name) {
      problems.push(`${file}: frontmatter name changed`);
    }
    if ((fmAfter.description ?? "").length > DESCRIPTION_LIMIT) {
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
  for (const line of addedLines) {
    const text = line.replaceAll("CLAUDE_PLUGIN_ROOT", "");
    const patterns = file.includes("/references/")
      ? [...JUNK_PATTERNS, ...REFERENCE_ONLY_PATTERNS]
      : JUNK_PATTERNS;
    for (const [pattern, reason] of patterns) {
      if (pattern.test(text)) {
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

function driftCounts(report) {
  const count = (heading) => {
    const start = report.indexOf(heading);
    if (start === -1) return 0;
    const rest = report.slice(start + heading.length);
    const end = rest.search(/\n### /);
    return (end === -1 ? rest : rest.slice(0, end))
      .split("\n")
      .filter((line) => line.startsWith("- ")).length;
  };
  return {
    missing: count("### References to endpoints that do not exist"),
    deprecated: count("### References to deprecated endpoints"),
  };
}

function runDriftCheck(growthbookDir, skillsDir) {
  try {
    return execFileSync(
      "node",
      [
        path.join(growthbookDir, "scripts/check-agent-skills-drift.mjs"),
        "--skills",
        skillsDir,
        "--spec",
        path.join(growthbookDir, "packages/back-end/generated/spec.yaml"),
      ],
      { encoding: "utf8" },
    );
  } catch (error) {
    return error.stdout ?? "";
  }
}

function guard() {
  const syncDir = env("SYNC_DIR");
  const skillsDir = env("SKILLS_DIR");
  const baseSha = env("BASE_SHA");
  const problems = [];

  if (git(skillsDir, "rev-parse", "HEAD").trim() !== baseSha) {
    problems.push(
      "Commits were made during the run; edits must stay uncommitted",
    );
  }
  const status = git(
    skillsDir,
    "status",
    "--porcelain",
    "--untracked-files=all",
  )
    .split("\n")
    .filter(Boolean);
  const changed = [];
  for (const entry of status) {
    const code = entry.slice(0, 2);
    const file = entry.slice(3);
    if (code.trim() !== "M" || !/^skills\/.+\.md$/.test(file)) {
      problems.push(
        `${file}: only edits to existing skills/**/*.md files are allowed (${code.trim()})`,
      );
    } else {
      changed.push(file);
    }
  }

  let changedLines = 0;
  for (const file of changed) {
    const diff = git(skillsDir, "diff", "--unified=0", baseSha, "--", file);
    const lines = diff.split("\n");
    const added = lines
      .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
      .map((l) => l.slice(1));
    changedLines += lines.filter(
      (l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l),
    ).length;
    problems.push(
      ...checkFile({
        file,
        before: git(skillsDir, "show", `${baseSha}:${file}`),
        after: readFileSync(path.join(skillsDir, file), "utf8"),
        addedLines: added,
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

  const before = driftCounts(readIfExists(path.join(syncDir, "drift.md")));
  const after = driftCounts(runDriftCheck(env("GROWTHBOOK_DIR"), skillsDir));
  if (after.missing > before.missing) {
    problems.push(
      `Missing-endpoint references went from ${before.missing} to ${after.missing}`,
    );
  }
  if (after.deprecated > before.deprecated) {
    problems.push(
      `Deprecated-endpoint references went from ${before.deprecated} to ${after.deprecated}`,
    );
  }
  if (
    changed.length > 0 &&
    !readIfExists(path.join(syncDir, "notes.md")).trim()
  ) {
    problems.push("Skills changed but .sync/notes.md is empty");
  }

  const report = problems.length
    ? ["### Guard rejected the edits", "", ...problems.map((p) => `- ${p}`), ""]
    : [`### Guard passed (${changed.length} files, ${changedLines} lines)`, ""];
  writeFileSync(path.join(syncDir, "guard.md"), report.join("\n"));
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

export function buildSection({ prs, notes, overlaps, before, after, date }) {
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
      );
    }
  } else {
    lines.push(
      `GrowthBook changes: https://github.com/growthbook/growthbook/compare/${before}...${after}`,
    );
  }
  lines.push("", linkedNotes);
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
  const refs = primary.map((pr) => `growthbook/growthbook#${pr.number}`);
  const subject = refs.length
    ? `Sync skills with ${refs.slice(0, 3).join(", ")}${refs.length > 3 ? " and more" : ""}`
    : "Sync skills with GrowthBook API changes";
  return { body: `${lines.join("\n")}\n`, subject };
}

function section() {
  const syncDir = env("SYNC_DIR");
  const { overlaps = [] } = JSON.parse(
    readIfExists(path.join(syncDir, "target.json")) || "{}",
  );
  const { body, subject } = buildSection({
    prs: growthbookPrs(syncDir),
    notes: readFileSync(path.join(syncDir, "notes.md"), "utf8"),
    overlaps,
    before: env("BEFORE"),
    after: env("AFTER"),
    date: new Date().toISOString().slice(0, 10),
  });
  writeFileSync(path.join(syncDir, "section.md"), body);
  writeFileSync(path.join(syncDir, "commit-message.txt"), `${subject}\n`);
}

function main() {
  const [command] = process.argv.slice(2);
  const syncDir = env("SYNC_DIR");
  if (command === "pick-target") {
    const target = pickTarget({
      openPrs: JSON.parse(
        readFileSync(path.join(syncDir, "open-prs.json"), "utf8"),
      ),
      growthbookPrs: growthbookPrs(syncDir),
      affected: affectedSkillFiles(
        readIfExists(path.join(syncDir, "drift.md")),
      ),
      syncBranch: env("SYNC_BRANCH"),
    });
    writeFileSync(
      path.join(syncDir, "target.json"),
      JSON.stringify(target, null, 2),
    );
    process.stdout.write(
      `kind=${target.kind}\nnumber=${target.number ?? ""}\nbranch=${target.branch}\n`,
    );
  } else if (command === "prompt") {
    const target = JSON.parse(
      readFileSync(path.join(syncDir, "target.json"), "utf8"),
    );
    const prs = growthbookPrs(syncDir);
    process.stdout.write(
      renderPrompt(readFileSync(path.join(HERE, "prompt.md"), "utf8"), {
        BEFORE: env("BEFORE"),
        AFTER: env("AFTER"),
        GROWTHBOOK_PRS: prs.length
          ? prs.map((pr) => `- #${pr.number} ${pr.title}`).join("\n")
          : "- None found; review the commit range directly.",
        TARGET:
          target.kind === "new"
            ? "No open PR covers this yet. Your edits start a new draft PR from `main`."
            : `Your edits are added to open PR #${target.number} (branch \`${target.branch}\`), which is checked out. It already changes: ${target.files.map((f) => `\`${f}\``).join(", ") || "nothing yet"}. Build on its changes; don't redo or undo them.`,
      }),
    );
  } else if (command === "guard") {
    guard();
  } else if (command === "section") {
    section();
  } else {
    throw new Error(`Unknown command: ${command ?? "(none)"}`);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main();
}
