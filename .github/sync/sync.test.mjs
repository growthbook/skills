import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  appendSection,
  buildSection,
  checkFile,
  collectPrs,
  findSecrets,
  guardEdits,
  lineDiff,
  overlapsFor,
  parseFrontmatter,
  pickTarget,
  questionsSection,
  renderPrompt,
} from "./sync.mjs";

const SKILL = [
  "---",
  "name: flag-toggle",
  "description: Toggle a flag.",
  "---",
  "",
  "# flag-toggle",
  "",
  "## Workflow",
  "",
  "1. Call `POST /api/v2/features/<flag-id>/revisions/new/toggle`.",
  "",
].join("\n");

const REFERENCE = "skills/feature-flags/references/flag-toggle.md";

const check = (addedLines, after = SKILL, before = SKILL, file = REFERENCE) =>
  checkFile({ file, before, after, addedLines, skillsDir: "." });

test("plain edits pass; questionable wording is a warning, not a failure", () => {
  const ok = check([
    "1. Call `POST /api/v2/features/<flag-id>/toggle` with `{environment}`.",
    "Safe to remove if no longer required.",
    "Use the `@growthbook/growthbook` SDK.",
    "Cursor-based pagination is not supported.",
  ]);
  assert.deepEqual(ok, { problems: [], warnings: [] });
  const flagged = check([
    "Updated per growthbook/growthbook#7180.",
    "As of v4.2 the endpoint requires `environment`.",
    "TODO: confirm the enum.",
    "Claude should ask first.",
    "Ship it ✅",
  ]);
  assert.equal(flagged.problems.length, 0);
  assert.equal(flagged.warnings.length, 5, flagged.warnings.join("\n"));
});

test("frontmatter is strict: single-line keys, quoted risky values, verbatim workflow descriptions", () => {
  assert.equal(parseFrontmatter(SKILL).entries.length, 2);
  assert.match(
    parseFrontmatter(SKILL.replace("Toggle a flag.", "Triggers include: x"))
      .error,
    /needs quotes/,
  );
  assert.match(
    parseFrontmatter(
      SKILL.replace("description: Toggle a flag.", "description: >-\n  long"),
    ).error,
    /not `key: value`/,
  );
  const router = (desc) =>
    SKILL.replace("name: flag-toggle", "name: feature-flags")
      .replace("Toggle a flag.", desc)
      .replace("description:", "allowed-tools: Bash(gb-call *)\ndescription:");
  const r = (after, before = router("Old.")) =>
    check([], after, before, "skills/feature-flags/SKILL.md").problems;
  assert.deepEqual(r(router("New triggers.")), []);
  assert.ok(r(router("x".repeat(1100))).some((p) => p.includes("over 1024")));
  assert.ok(
    r(router("Old.").replace("Bash(gb-call *)", "Bash(*)")).some((p) =>
      p.includes("other than `description`"),
    ),
  );
  assert.ok(
    check([], SKILL.replace("Toggle a flag.", "Turn a flag on.")).problems.some(
      (p) => p.includes("must stay verbatim"),
    ),
  );
  assert.ok(
    check([], SKILL.replace("description: Toggle a flag.\n", "")).problems.some(
      (p) => p.includes("was removed"),
    ),
  );
});

test("rejects new sections but allows a Contents index", () => {
  assert.ok(
    check([], SKILL.concat("\n## Notes\n\nExtra.\n")).problems.some((p) =>
      p.includes("sections changed"),
    ),
  );
  const withContents = SKILL.replace(
    "## Workflow",
    "## Contents\n\n- Workflow\n\n## Workflow",
  );
  assert.deepEqual(check([], withContents).problems, []);
});

test("line diff sees lines git would hide, including ++ prefixes", () => {
  const { added, removed } = lineDiff(
    "a\nb\nc\n",
    "a\n++ Updated per growthbook/growthbook#1\nc\n-- x\n",
  );
  assert.deepEqual(added, ["++ Updated per growthbook/growthbook#1", "-- x"]);
  assert.deepEqual(removed, ["b"]);
});

test("detects secrets", () => {
  assert.equal(findSecrets("token ghp_" + "a".repeat(36)).length, 1);
  assert.equal(findSecrets("key sk-ant-" + "b".repeat(40)).length, 1);
  assert.deepEqual(findSecrets("GET /api/v2/features"), []);
});

test("collects GrowthBook PRs and a commit map from JSON lines", () => {
  const { prs, bySha } = collectPrs(
    [
      '{"sha":"b","number":7181,"title":"Second","linked":[]}',
      '{"sha":"a","number":7180,"title":"First","linked":[20,9]}',
      '{"sha":"c","number":7180,"title":"First","linked":[20,9]}',
    ].join("\n"),
  );
  assert.deepEqual(
    prs.map((p) => p.number),
    [7180, 7181],
  );
  assert.deepEqual(prs[0].linkedSkillsPrs, [20, 9]);
  assert.deepEqual(bySha, { a: 7180, b: 7181, c: 7180 });
});

test("always targets the sync PR and lists paired PRs, forks included", () => {
  const sync = {
    number: 1,
    headRefName: "sync/growthbook",
    headRefOid: "abc",
    files: [{ path: "skills/a.md" }],
    body: "",
  };
  const named = {
    number: 3,
    headRefName: "sam/x",
    body: "Follows growthbook/growthbook#7180",
  };
  const fork = {
    number: 4,
    headRefName: "main",
    isCrossRepository: true,
    body: "",
  };
  const forkedSync = {
    number: 5,
    headRefName: "sync/growthbook",
    isCrossRepository: true,
    body: "",
  };
  const growthbookPrs = [
    { number: 7180, title: "x", linkedSkillsPrs: [] },
    { number: 7181, title: "y", linkedSkillsPrs: [4] },
  ];
  const target = pickTarget({
    openPrs: [sync, named, fork, forkedSync],
    growthbookPrs,
    syncBranch: "sync/growthbook",
  });
  assert.equal(target.kind, "sync");
  assert.equal(target.number, 1);
  assert.equal(target.headSha, "abc");
  assert.deepEqual(target.paired, [
    { growthbook: 7180, skills: 3 },
    { growthbook: 7181, skills: 4 },
  ]);
  assert.equal(
    pickTarget({
      openPrs: [forkedSync],
      growthbookPrs,
      syncBranch: "sync/growthbook",
    }).kind,
    "new",
  );
});

test("overlaps come from the files this run changed", () => {
  const open = [
    { number: 1, files: [{ path: "skills/a.md" }] },
    { number: 20, files: [{ path: "skills/b.md" }, { path: "skills/c.md" }] },
  ];
  assert.deepEqual(overlapsFor(open, ["skills/a.md", "skills/b.md"], 1), [
    { number: 20, files: ["skills/b.md"] },
  ]);
  assert.deepEqual(overlapsFor(open, ["skills/z.md"], 1), []);
});

test("renders every placeholder and rejects unknown ones", () => {
  assert.equal(renderPrompt("{{A}} and {{B}}", { A: "1", B: "2" }), "1 and 2");
  assert.throws(() => renderPrompt("{{C}}", {}), /Unknown placeholder/);
});

test("section links GrowthBook PRs, leads with cited ones, and lists warnings and pairings", () => {
  const prs = [
    { number: 7125, title: "Key regex", linkedSkillsPrs: [] },
    { number: 7156, title: "Release SDKs", linkedSkillsPrs: [] },
  ];
  const { body, subject } = buildSection({
    prs,
    notes:
      "#### Changes\n\n- `skills/x.md`: fixed path.\n\n#### Checked, no change\n\n- SDK (#7156): no API change.\n\n#### Needs a human\n\n- `skills/y.md`: regex from #7125?",
    overlaps: [{ number: 20, files: ["skills/x.md"] }],
    paired: [{ growthbook: 7041, skills: 20 }],
    warnings: ["skills/x.md: emoji: `ok ✅`"],
    before: "a",
    after: "b",
    date: "2026-10-01",
  });
  assert.match(
    body,
    /^### Sync 2026-10-01\n\nGrowthBook PRs:\n- growthbook\/growthbook#7125 Key regex/,
  );
  assert.match(
    body,
    /<summary>Also reviewed \(1\)<\/summary>[\s\S]*growthbook\/growthbook#7156/,
  );
  assert.match(body, /SDK \(growthbook\/growthbook#7156\)/);
  assert.match(body, /#### Wording to check\n\n- skills\/x.md: emoji/);
  assert.match(body, /Paired skills PRs: growthbook\/growthbook#7041 → #20/);
  assert.match(body, /Also changed in other open PRs: #20/);
  assert.equal(subject, "Sync skills with GrowthBook API changes");
});

test("appended sections stay under the limit and keep the trim note", () => {
  let body = appendSection("", "### Sync 2026-01-01\n\nfirst");
  assert.match(body, /^Draft from the GrowthBook sync job/);
  for (let i = 2; i <= 6; i++) {
    body = appendSection(
      body,
      `### Sync 2026-01-0${i}\n\n${"x".repeat(300)}`,
      1000,
    );
  }
  assert.ok(body.length <= 1000);
  assert.match(body, /### Sync 2026-01-06/);
  assert.doesNotMatch(body, /### Sync 2026-01-01/);
  body = appendSection(body, "### Sync 2026-01-07\n\nshort", 5000);
  assert.equal(body.match(/Older sync sections were trimmed/g).length, 1);
});

test("questions come from the Needs a human section only", () => {
  assert.equal(
    questionsSection(
      "#### Changes\n\n- a\n\n#### Needs a human\n\n- q1\n- q2\n",
    ),
    "#### Needs a human\n\n- q1\n- q2",
  );
  assert.equal(questionsSection("#### Changes\n\n- a\n"), "");
});

function repoWithSkill() {
  const dir = mkdtempSync(path.join(tmpdir(), "sync-guard-"));
  const run = (...args) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  run("init", "-q");
  mkdirSync(path.join(dir, "skills/feature-flags/references"), {
    recursive: true,
  });
  writeFileSync(path.join(dir, REFERENCE), SKILL);
  writeFileSync(path.join(dir, "README.md"), "readme\n");
  run("add", ".");
  run("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  return { dir, sha: run("rev-parse", "HEAD").trim() };
}

function stubChecker(dir, name, script) {
  const file = path.join(dir, name);
  writeFileSync(file, script);
  return file;
}

test("guard compares content directly and fails closed", () => {
  const { dir, sha } = repoWithSkill();
  const tools = mkdtempSync(path.join(tmpdir(), "sync-tools-"));
  try {
    const ok = stubChecker(
      tools,
      "ok.mjs",
      "console.log(JSON.stringify({ introduced: [] }));",
    );
    const args = { skillsDir: dir, baseSha: sha, checker: ok, spec: "unused" };
    const file = path.join(dir, REFERENCE);

    writeFileSync(file, SKILL.replace("revisions/new/toggle", "toggle"));
    assert.deepEqual(guardEdits(args).problems, []);
    assert.equal(guardEdits(args).changedLines, 2);

    // Ignore and attribute files must not hide edits.
    writeFileSync(
      path.join(dir, "skills/.gitignore"),
      ".gitignore\n.gitattributes\nhidden.md\n",
    );
    writeFileSync(path.join(dir, "skills/.gitattributes"), "*.md -diff\n");
    writeFileSync(file, SKILL + "x\n".repeat(250));
    const hidden = guardEdits(args);
    assert.ok(
      hidden.problems.some((p) => p.includes("skills/.gitignore: new files")),
    );
    assert.ok(hidden.problems.some((p) => p.includes("lines changed")));
    rmSync(path.join(dir, "skills/.gitignore"));
    rmSync(path.join(dir, "skills/.gitattributes"));

    writeFileSync(file, SKILL);
    writeFileSync(path.join(dir, "README.md"), "changed\n");
    assert.ok(
      guardEdits(args).problems.some((p) =>
        p.includes("README.md: only existing"),
      ),
    );
    writeFileSync(path.join(dir, "README.md"), "readme\n");

    writeFileSync(
      file,
      SKILL.replace("toggle`.", "toggle`. ghp_" + "a".repeat(36)),
    );
    assert.ok(
      guardEdits(args).problems.some((p) => p.includes("looks like a secret")),
    );

    writeFileSync(file, SKILL.replace("revisions/new/toggle", "toggle"));
    const introduced = stubChecker(
      tools,
      "introduced.mjs",
      'console.log(JSON.stringify({ introduced: [{ file: "skills/x.md", line: 3, method: "GET", path: "/v2/made-up", detail: "no such path" }] }));',
    );
    assert.ok(
      guardEdits({ ...args, checker: introduced }).problems.some((p) =>
        p.includes("new reference to a missing endpoint"),
      ),
    );
    const crash = stubChecker(tools, "crash.mjs", "process.exit(3);");
    assert.ok(
      guardEdits({ ...args, checker: crash }).problems.some((p) =>
        p.includes("drift checker failed"),
      ),
    );
    assert.ok(
      guardEdits({
        ...args,
        notesFile: path.join(tools, "none.md"),
      }).problems.some((p) => p.includes("notes file is empty")),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(tools, { recursive: true, force: true });
  }
});
