import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  checkSkillFile,
  findSecrets,
  guard,
  lineDiff,
  parseFrontmatter,
} from "./guard.mjs";

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

const check = (
  after,
  { before = SKILL, file = REFERENCE, strict = true, added = [] } = {},
) =>
  checkSkillFile({
    file,
    before,
    after,
    addedLines: added,
    headFiles: new Map([[REFERENCE, {}]]),
    strict,
  });

test("wording is a warning, never a failure", () => {
  const result = check(SKILL, {
    added: [
      "Updated per growthbook/growthbook#7180.",
      "TODO: confirm.",
      "Claude asks first.",
      "Ship it ✅",
    ],
  });
  assert.deepEqual(result.problems, []);
  assert.equal(result.warnings.length, 4);
  assert.deepEqual(
    check(SKILL, {
      added: [
        "Safe to remove if no longer required.",
        "Use the `@growthbook/growthbook` SDK.",
      ],
    }).warnings,
    [],
  );
});

test("frontmatter grammar applies to every PR; sync PRs also keep it fixed", () => {
  assert.match(
    parseFrontmatter(SKILL.replace("Toggle a flag.", "Triggers include: x"))
      .error,
    /needs quotes/,
  );
  assert.match(
    parseFrontmatter(
      SKILL.replace("description: Toggle a flag.", "description: >-\n  x"),
    ).error,
    /not `key: value`/,
  );
  const missing = SKILL.replace("description: Toggle a flag.\n", "");
  assert.ok(
    check(missing, { strict: false }).problems.some((p) =>
      p.includes("missing"),
    ),
  );
  const reworded = SKILL.replace("Toggle a flag.", "Turn a flag on.");
  assert.deepEqual(check(reworded, { strict: false }).problems, []);
  assert.ok(check(reworded).problems.some((p) => p.includes("verbatim")));
  const widened = SKILL.replace(
    "description:",
    "allowed-tools: Bash(*)\ndescription:",
  );
  assert.ok(
    check(widened).problems.some((p) => p.includes("other than `description`")),
  );
});

test("sync PRs keep sections; a Contents index is allowed", () => {
  assert.ok(
    check(SKILL + "\n## Notes\n").problems.some((p) =>
      p.includes("sections changed"),
    ),
  );
  assert.deepEqual(
    check(SKILL.replace("## Workflow", "## Contents\n\n- x\n\n## Workflow"))
      .problems,
    [],
  );
  assert.deepEqual(
    check(SKILL + "\n## Notes\n", { strict: false }).problems,
    [],
  );
});

test("line diff keeps ++ and -- lines", () => {
  assert.deepEqual(lineDiff("a\nb\n", "a\n++ x\n-- y\n"), {
    added: ["++ x", "-- y"],
    removed: ["b"],
  });
});

test("detects known and encoded secrets without flagging skill text", () => {
  assert.ok(findSecrets("ghs_" + "a".repeat(36)).length > 0);
  assert.ok(
    findSecrets(Buffer.from("ghs_" + "a".repeat(36)).toString("base64"))
      .length > 0,
  );
  assert.ok(
    findSecrets(Buffer.from("sk-ant-api03-" + "b".repeat(40)).toString("hex"))
      .length > 0,
  );
  assert.ok(
    findSecrets(
      ["ey", "JhbGciOiJSUzI1NiJ9", ".", "ey", "JzdWIiOiIxMjM0NTY3OD"].join(""),
    ).length > 0,
  );
  for (const ok of [
    "/api/v1/product-analytics/fact-table-exploration",
    "publishPendingFeatureDraftsForExperiment",
    "------------------------------------------------------------",
  ]) {
    assert.deepEqual(findSecrets(ok), [], ok);
  }
});

function repo() {
  const dir = mkdtempSync(path.join(tmpdir(), "skills-guard-test-"));
  const run = (...args) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  run("init", "-q");
  mkdirSync(path.join(dir, "skills/feature-flags/references"), {
    recursive: true,
  });
  mkdirSync(path.join(dir, "skills/feature-flags/scripts"), {
    recursive: true,
  });
  writeFileSync(path.join(dir, REFERENCE), SKILL);
  writeFileSync(path.join(dir, "README.md"), "readme\n");
  symlinkSync(
    "../../../scripts/gb-call",
    path.join(dir, "skills/feature-flags/scripts/gb-call"),
  );
  const commit = (message) => {
    run("add", "-A");
    run(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-qm",
      message,
      "--allow-empty",
    );
    return run("rev-parse", "HEAD").trim();
  };
  return { dir, commit };
}

test("guard checks commits, not the working tree, and fails closed", () => {
  const { dir, commit } = repo();
  const tools = mkdtempSync(path.join(tmpdir(), "skills-guard-tools-"));
  try {
    const ok = path.join(tools, "ok.mjs");
    writeFileSync(ok, "console.log(JSON.stringify({ introduced: [] }));");
    const crash = path.join(tools, "crash.mjs");
    writeFileSync(crash, "process.exit(3);");
    const base = commit("base");
    const run = (head, extra = {}) =>
      guard({
        repo: dir,
        baseSha: base,
        headSha: head,
        checker: ok,
        spec: "x",
        strict: true,
        ...extra,
      });

    writeFileSync(
      path.join(dir, REFERENCE),
      SKILL.replace("revisions/new/toggle", "toggle"),
    );
    const fix = commit("fix");
    assert.deepEqual(run(fix).problems, []);
    assert.equal(run(fix).changedLines, 2);
    assert.ok(
      run(fix, { checker: crash }).problems.some((p) =>
        p.includes("drift checker failed"),
      ),
    );

    writeFileSync(path.join(dir, "skills/.gitattributes"), "*.md -diff\n");
    writeFileSync(path.join(dir, "README.md"), "changed\n");
    const sneaky = commit("sneaky");
    const strict = run(sneaky).problems;
    assert.ok(
      strict.some((p) =>
        p.includes("skills/.gitattributes: sync PRs may only add a workflow"),
      ),
    );
    assert.ok(
      strict.some((p) => p.includes("README.md: sync PRs may only edit")),
    );
    assert.deepEqual(run(sneaky, { strict: false }).problems, []);

    writeFileSync(
      path.join(dir, "README.md"),
      "token ghp_" + "c".repeat(36) + "\n",
    );
    const leaky = commit("leaky");
    assert.ok(
      run(leaky, { strict: false }).problems.some((p) =>
        p.includes("README.md: added text looks like a secret"),
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(tools, { recursive: true, force: true });
  }
});

test("sync PRs may add one workflow shaped like its siblings and listed in its router", () => {
  const { dir, commit } = repo();
  const tools = mkdtempSync(path.join(tmpdir(), "skills-guard-tools-"));
  try {
    const ok = path.join(tools, "ok.mjs");
    writeFileSync(ok, "console.log(JSON.stringify({ introduced: [] }));");
    const router = path.join(dir, "skills/feature-flags/SKILL.md");
    writeFileSync(
      router,
      SKILL.replace("name: flag-toggle", "name: feature-flags")
        .replace("# flag-toggle", "# feature-flags")
        .concat("| `references/flag-toggle.md` | Toggle |\n"),
    );
    const base = commit("router");
    const run = (head) =>
      guard({
        repo: dir,
        baseSha: base,
        headSha: head,
        checker: ok,
        spec: "x",
        strict: true,
      }).problems;
    const workflow = (name, sections) =>
      [
        "---",
        `name: ${name}`,
        "description: Copy a flag.",
        "---",
        "",
        `# ${name}`,
        "",
        "Copy a flag.",
        "",
        ...sections.flatMap((s) => [s, "", "Text.", ""]),
      ].join("\n");
    const full = [
      "## Workflow",
      "## Guardrails",
      "## Endpoints used",
      "## Handoffs",
    ];
    const file = path.join(dir, "skills/feature-flags/references/flag-copy.md");

    writeFileSync(file, workflow("flag-copy", full));
    assert.ok(
      run(commit("unlisted")).some((p) =>
        p.includes("must list `references/flag-copy.md`"),
      ),
    );

    writeFileSync(
      router,
      readFileSync(router, "utf8") + "| `references/flag-copy.md` | Copy |\n",
    );
    assert.deepEqual(run(commit("listed")), []);

    writeFileSync(file, workflow("flag-copy", full.slice(0, 2)));
    assert.ok(run(commit("short")).some((p) => p.includes("in that order")));

    writeFileSync(file, workflow("flag-copier", full));
    assert.ok(
      run(commit("misnamed")).some((p) =>
        p.includes("`name` must be `flag-copy`"),
      ),
    );

    writeFileSync(file, workflow("flag-copy", full));
    writeFileSync(
      path.join(dir, "skills/feature-flags/references/flag-move.md"),
      workflow("flag-move", full),
    );
    writeFileSync(
      router,
      readFileSync(router, "utf8") + "| `references/flag-move.md` | Move |\n",
    );
    assert.ok(run(commit("two")).some((p) => p.includes("at most one")));

    mkdirSync(path.join(dir, "skills/billing/references"), { recursive: true });
    writeFileSync(
      path.join(dir, "skills/billing/references/invoice.md"),
      workflow("invoice", full),
    );
    assert.ok(
      run(commit("domain")).some((p) =>
        p.includes(
          "skills/billing/references/invoice.md: sync PRs may only add",
        ),
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(tools, { recursive: true, force: true });
  }
});

test("large sync PRs warn; runaway ones are rejected", () => {
  const { dir, commit } = repo();
  const tools = mkdtempSync(path.join(tmpdir(), "skills-guard-tools-"));
  try {
    const ok = path.join(tools, "ok.mjs");
    writeFileSync(ok, "console.log(JSON.stringify({ introduced: [] }));");
    const base = commit("base");
    const run = (head) =>
      guard({
        repo: dir,
        baseSha: base,
        headSha: head,
        checker: ok,
        spec: "x",
        strict: true,
      });
    const file = path.join(dir, REFERENCE);
    writeFileSync(file, SKILL + "Step.\n".repeat(300));
    const large = run(commit("large"));
    assert.deepEqual(large.problems, []);
    assert.ok(large.warnings.some((w) => w.includes("consider splitting")));
    writeFileSync(file, SKILL + "Step.\n".repeat(1200));
    assert.ok(
      run(commit("runaway")).problems.some((p) => p.includes("Split it")),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(tools, { recursive: true, force: true });
  }
});
