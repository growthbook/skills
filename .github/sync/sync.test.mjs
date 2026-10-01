import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  affectedSkillFiles,
  appendSection,
  buildSection,
  checkFile,
  collectPrs,
  guardEdits,
  pickTarget,
  renderPrompt,
  lastSyncTime,
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

const check = (addedLines, after = SKILL, before = SKILL) =>
  checkFile({
    file: "skills/feature-flags/references/flag-toggle.md",
    before,
    after,
    addedLines,
    skillsDir: ".",
  });

test("accepts a plain factual edit and existing human phrasing", () => {
  assert.deepEqual(
    check([
      "1. Call `POST /api/v2/features/<flag-id>/toggle` with `{environment}`.",
      "Re-sending it would invalidate previously-granted approvals.",
      "Archive the flag if it is no longer needed.",
    ]),
    [],
  );
});

test("rejects PR links, changelog wording, markers, provider names and emoji", () => {
  const lines = [
    "Updated per growthbook/growthbook#7180.",
    "See growthbook/skills#20 for context.",
    "As of v4.2 the endpoint requires `environment`.",
    "The field has been renamed to `env`.",
    "Previously, this returned a 200.",
    "The v1 route is no longer supported.",
    "TODO: confirm the enum.",
    "Claude should ask first.",
    "Ship it ✅",
    "Careful ⚠️ here",
    "<!-- generated -->",
  ];
  const problems = check(lines);
  assert.equal(problems.length, lines.length, problems.join("\n"));
});

test("rejects frontmatter changes outside description, and long block descriptions", () => {
  const router = SKILL.replace(
    "description: Toggle a flag.\n",
    "description: Toggle a flag.\nallowed-tools: Bash(gb-call *)\n",
  );
  const widened = router.replace("Bash(gb-call *)", "Bash(*)");
  assert.ok(
    check([], widened, router).some((p) =>
      p.includes("other than `description`"),
    ),
  );
  const added = SKILL.replace("---\n\n#", "license: MIT\n---\n\n#");
  assert.ok(
    check([], added).some((p) => p.includes("other than `description`")),
  );
  const long = SKILL.replace(
    "description: Toggle a flag.",
    `description: >-\n  ${"word ".repeat(260)}`,
  );
  assert.ok(check([], long).some((p) => p.includes("over 1024")));
  assert.deepEqual(
    check([], SKILL.replace("Toggle a flag.", "Turn a flag on or off.")),
    [],
  );
});

test("rejects new sections but allows a Contents index", () => {
  assert.ok(
    check([], SKILL.concat("\n## Notes\n\nExtra.\n")).some((p) =>
      p.includes("sections changed"),
    ),
  );
  const withContents = SKILL.replace(
    "## Workflow",
    "## Contents\n\n- Workflow\n\n## Workflow",
  );
  assert.deepEqual(check([], withContents), []);
});

test("collects GrowthBook PRs and a commit map", () => {
  const { tsv, bySha } = collectPrs(
    "b\t7181\tSecond\t\na\t7180\tFirst\t20,9\nc\t7180\tFirst\t20,9\n",
  );
  assert.equal(tsv, "7180\tFirst\t20,9\n7181\tSecond\t\n");
  assert.deepEqual(bySha, { a: 7180, b: 7181, c: 7180 });
});

test("finds affected skill files in a JSON drift report", () => {
  assert.deepEqual(
    affectedSkillFiles({
      impacted: [
        { key: "POST /v1/x", kind: "changed", files: ["skills/b.md"] },
      ],
      missing: [{ file: "skills/a.md" }],
      deprecated: [],
    }),
    ["skills/a.md", "skills/b.md"],
  );
});

test("adds to a paired PR only when the run covers that GrowthBook PR alone", () => {
  const sync = {
    number: 1,
    headRefName: "sync/growthbook",
    files: [],
    body: "",
  };
  const overlap = {
    number: 2,
    headRefName: "jd/visual-editor",
    files: [{ path: "skills/feature-flags/references/flag-review.md" }],
    body: "",
  };
  const mentions = {
    number: 3,
    headRefName: "sam/api-change",
    files: [],
    body: "Follows growthbook/growthbook#7180",
  };
  const linked = { number: 5, headRefName: "kim/fix", files: [], body: "" };
  const fork = { ...mentions, number: 4, isCrossRepository: true };
  const pr7180 = { number: 7180, title: "x", linkedSkillsPrs: [] };
  const base = {
    affected: ["skills/feature-flags/references/flag-review.md"],
    syncBranch: "sync/growthbook",
  };

  const single = pickTarget({
    ...base,
    growthbookPrs: [pr7180],
    openPrs: [sync, overlap, mentions, fork],
  });
  assert.equal(single.kind, "related");
  assert.equal(single.number, 3);
  assert.deepEqual(single.overlaps, [
    { number: 2, files: ["skills/feature-flags/references/flag-review.md"] },
  ]);

  const reverse = pickTarget({
    ...base,
    growthbookPrs: [{ number: 7181, title: "y", linkedSkillsPrs: [5] }],
    openPrs: [sync, linked],
  });
  assert.equal(reverse.number, 5);

  const many = pickTarget({
    ...base,
    growthbookPrs: [pr7180, { number: 7200, title: "z", linkedSkillsPrs: [] }],
    openPrs: [sync, mentions],
  });
  assert.equal(many.kind, "sync");
  assert.deepEqual(many.paired, [
    { growthbook: 7180, skills: 3, branch: "sam/api-change" },
  ]);

  assert.equal(
    pickTarget({ ...base, growthbookPrs: [pr7180], openPrs: [sync, overlap] })
      .kind,
    "sync",
  );
  assert.equal(
    pickTarget({ ...base, growthbookPrs: [pr7180], openPrs: [fork, overlap] })
      .kind,
    "new",
  );
});

test("the review window starts an hour before the last successful real run", () => {
  const runs = [
    {
      conclusion: null,
      display_title: "Sync with GrowthBook",
      run_started_at: "2026-10-05T14:00:00Z",
    },
    {
      conclusion: "success",
      display_title: "Dry run: Sync with GrowthBook",
      run_started_at: "2026-10-04T14:00:00Z",
    },
    {
      conclusion: "failure",
      display_title: "Sync with GrowthBook",
      run_started_at: "2026-10-03T14:00:00Z",
    },
    {
      conclusion: "success",
      display_title: "Sync with GrowthBook",
      run_started_at: "2026-10-02T14:00:00Z",
    },
  ];
  assert.equal(lastSyncTime(runs), "2026-10-02T13:00:00.000Z");
  assert.equal(lastSyncTime(runs.slice(0, 3)), null);
});

test("renders every placeholder and rejects unknown ones", () => {
  assert.equal(renderPrompt("{{A}} and {{B}}", { A: "1", B: "2" }), "1 and 2");
  assert.throws(() => renderPrompt("{{C}}", {}), /Unknown placeholder/);
});

test("section links GrowthBook PRs, leads with the cited ones, and folds the rest", () => {
  const prs = [
    {
      number: 7125,
      title: "Enforce experiment key format",
      linkedSkillsPrs: [],
    },
    { number: 7156, title: "Release SDKs", linkedSkillsPrs: [] },
  ];
  const { body, subject } = buildSection({
    prs,
    notes:
      "#### Changes\n\n- `skills/x.md`: key regex (#7125). Unrelated #12 stays.\n\n#### Checked, no change\n\n- SDK release (#7156): no API change.",
    overlaps: [{ number: 20, files: ["skills/x.md"] }],
    paired: [{ growthbook: 7041, skills: 20 }],
    before: "a",
    after: "b",
    date: "2026-10-01",
  });
  assert.match(
    body,
    /^### Sync 2026-10-01\n\nGrowthBook PRs:\n- growthbook\/growthbook#7125 /,
  );
  assert.match(
    body,
    /<summary>Also reviewed \(1\)<\/summary>[\s\S]*growthbook\/growthbook#7156/,
  );
  assert.match(body, /key regex \(growthbook\/growthbook#7125\)/);
  assert.match(body, /SDK release \(growthbook\/growthbook#7156\)/);
  assert.match(body, /Unrelated #12 stays/);
  assert.match(body, /Paired skills PRs: growthbook\/growthbook#7041 → #20/);
  assert.match(body, /Also changed in other open PRs: #20/);
  assert.equal(subject, "Sync skills with growthbook/growthbook#7125");
});

test("section folds every PR when none caused a change", () => {
  const prs = [1, 2, 3, 4].map((number) => ({
    number,
    title: `PR ${number}`,
    linkedSkillsPrs: [],
  }));
  const { body, subject } = buildSection({
    prs,
    notes: "#### Changes\n\n- `skills/x.md`: fixed an old path.",
    overlaps: [],
    paired: [],
    before: "a",
    after: "b",
    date: "2026-10-01",
  });
  assert.match(
    body,
    /^### Sync 2026-10-01\n\n<details><summary>GrowthBook PRs reviewed \(4\)<\/summary>/,
  );
  assert.equal(subject, "Sync skills with GrowthBook API changes");
});

test("appended sync sections stay under the description limit", () => {
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
  assert.match(body, /Older sync sections were trimmed/);
  assert.match(body, /### Sync 2026-01-06/);
  assert.doesNotMatch(body, /### Sync 2026-01-01/);
  assert.equal(body.match(/Older sync sections were trimmed/g).length, 1);
});

function repoWithSkill() {
  const dir = mkdtempSync(path.join(tmpdir(), "sync-guard-"));
  const run = (...args) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  run("init", "-q");
  mkdirSync(path.join(dir, "skills/feature-flags/references"), {
    recursive: true,
  });
  writeFileSync(
    path.join(dir, "skills/feature-flags/references/flag-toggle.md"),
    SKILL,
  );
  run("add", ".");
  run("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  return { dir, sha: run("rev-parse", "HEAD").trim() };
}

function stubChecker(dir, script) {
  const file = path.join(dir, "checker.mjs");
  writeFileSync(file, script);
  return file;
}

test("guard passes clean edits and fails closed when the checker breaks", () => {
  const { dir, sha } = repoWithSkill();
  const tools = mkdtempSync(path.join(tmpdir(), "sync-tools-"));
  try {
    const file = path.join(
      dir,
      "skills/feature-flags/references/flag-toggle.md",
    );
    writeFileSync(file, SKILL.replace("revisions/new/toggle", "toggle"));
    const ok = stubChecker(
      tools,
      "console.log(JSON.stringify({ introduced: [] }));",
    );
    const args = { skillsDir: dir, baseSha: sha, checker: ok, spec: "unused" };
    assert.deepEqual(guardEdits(args).problems, []);

    const introduced = stubChecker(
      tools,
      'console.log(JSON.stringify({ introduced: [{ file: "skills/x.md", line: 3, method: "GET", path: "/v2/made-up", detail: "no such path" }] }));',
    );
    assert.ok(
      guardEdits({ ...args, checker: introduced }).problems.some((p) =>
        p.includes("new reference to a missing endpoint"),
      ),
    );

    const crash = stubChecker(tools, "process.exit(3);");
    assert.ok(
      guardEdits({ ...args, checker: crash }).problems.some((p) =>
        p.includes("drift checker failed"),
      ),
    );

    writeFileSync(path.join(dir, "skills/new.md"), "x");
    assert.ok(
      guardEdits({ ...args, checker: ok }).problems.some((p) =>
        p.includes("skills/new.md: only edits"),
      ),
    );
    assert.ok(
      guardEdits({
        ...args,
        checker: ok,
        notesFile: path.join(tools, "none.md"),
      }).problems.some((p) => p.includes("notes file is empty")),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(tools, { recursive: true, force: true });
  }
});

test("subject cites only PRs behind a change", () => {
  const { subject, body } = buildSection({
    prs: [
      { number: 7125, title: "Key regex", linkedSkillsPrs: [] },
      { number: 7150, title: "Dashboards", linkedSkillsPrs: [] },
    ],
    notes:
      "#### Changes\n\n- `skills/x.md`: fixed an old path.\n\n#### Needs a human\n\n- `skills/y.md`: regex from #7125?",
    overlaps: [],
    paired: [],
    before: "a",
    after: "b",
    date: "2026-10-01",
  });
  assert.equal(subject, "Sync skills with GrowthBook API changes");
  assert.match(
    body,
    /GrowthBook PRs:\n- growthbook\/growthbook#7125 Key regex/,
  );
});
