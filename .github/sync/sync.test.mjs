import assert from "node:assert/strict";
import { test } from "node:test";
import {
  affectedSkillFiles,
  buildSection,
  checkFile,
  pickTarget,
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

const check = (addedLines, after = SKILL) =>
  checkFile({
    file: "skills/feature-flags/references/flag-toggle.md",
    before: SKILL,
    after,
    addedLines,
    skillsDir: ".",
  });

test("accepts a plain factual edit", () => {
  assert.deepEqual(
    check([
      "1. Call `POST /api/v2/features/<flag-id>/toggle` with `{environment}`.",
    ]),
    [],
  );
});

test("rejects PR links, changelog wording, markers, provider names and emoji", () => {
  const lines = [
    "Updated per growthbook/growthbook#7180.",
    "As of v4.2 the endpoint requires `environment`.",
    "The field has been renamed to `env`.",
    "TODO: confirm the enum.",
    "Claude should ask first.",
    "Ship it ✅",
    "<!-- generated -->",
  ];
  const problems = check(lines);
  assert.equal(problems.length, lines.length, problems.join("\n"));
});

test("rejects new sections and frontmatter name changes", () => {
  const after = SKILL.replace("name: flag-toggle", "name: toggle").concat(
    "\n## Notes\n\nExtra.\n",
  );
  const problems = check([], after);
  assert.ok(problems.some((p) => p.includes("name changed")));
  assert.ok(problems.some((p) => p.includes("sections changed")));
});

test("finds affected skill files in a drift report", () => {
  const report = [
    "- `POST /v1/experiments/{id}/start` (changed): `skills/experiments/references/experiment-launch.md`",
    "- `skills/feature-flags/references/flag-review.md:67` — `GET /api/v2/flag-revisions` (no such path)",
  ].join("\n");
  assert.deepEqual(affectedSkillFiles(report), [
    "skills/experiments/references/experiment-launch.md",
    "skills/feature-flags/references/flag-review.md",
  ]);
});

test("adds only to an explicitly linked PR; file overlap is reported, not used", () => {
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
  const linkedFromGrowthbook = {
    number: 5,
    headRefName: "kim/fix",
    files: [],
    body: "",
  };
  const fork = { ...mentions, number: 4, isCrossRepository: true };
  const base = {
    growthbookPrs: [{ number: 7180, title: "x", linkedSkillsPrs: [] }],
    affected: ["skills/feature-flags/references/flag-review.md"],
    syncBranch: "sync/growthbook",
  };

  const named = pickTarget({
    ...base,
    openPrs: [sync, overlap, mentions, fork],
  });
  assert.equal(named.kind, "related");
  assert.equal(named.number, 3);
  assert.deepEqual(named.overlaps, [
    { number: 2, files: ["skills/feature-flags/references/flag-review.md"] },
  ]);

  const reverse = pickTarget({
    ...base,
    growthbookPrs: [{ number: 7181, title: "y", linkedSkillsPrs: [5] }],
    openPrs: [sync, linkedFromGrowthbook],
  });
  assert.equal(reverse.number, 5);

  const onlyOverlap = pickTarget({ ...base, openPrs: [sync, overlap] });
  assert.equal(onlyOverlap.kind, "sync");
  assert.equal(onlyOverlap.overlaps[0].number, 2);

  assert.equal(pickTarget({ ...base, openPrs: [fork, overlap] }).kind, "new");
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
