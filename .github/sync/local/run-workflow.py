#!/usr/bin/env python3
"""Run .github/workflows/sync-from-growthbook.yml locally, step by step.

Used by run-local.sh, which prepares the workspace. Each `run:` step runs
with bash -eo pipefail and GitHub-style GITHUB_OUTPUT, GITHUB_ENV and
GITHUB_STEP_SUMMARY files; `if:` conditions, step outcomes, always() and
continue-on-error behave as on Actions. Checkout, setup-node and
upload-artifact steps are skipped (run-local.sh does their work), and the
claude-code-action step runs the local `claude` CLI with the workflow's own
claude_args.

Usage: run-workflow.py <workflow.yml> <workspace> '<inputs JSON>'
Requires PyYAML (`pip install pyyaml`).
"""
import json
import os
import re
import shlex
import subprocess
import sys

try:
    import yaml
except ImportError:
    sys.exit("PyYAML is required: pip install pyyaml")

workflow_file, workspace, inputs_json = sys.argv[1:4]
inputs = json.loads(inputs_json)
workflow = yaml.safe_load(open(workflow_file))
runner_temp = os.path.join(workspace, "_runner_temp")
os.makedirs(runner_temp, exist_ok=True)
summary = os.path.join(runner_temp, "summary.md")
open(summary, "w").close()

token = subprocess.run(
    ["gh", "auth", "token"], capture_output=True, text=True
).stdout.strip()
github = {
    "token": token,
    "workspace": workspace,
    "server_url": "https://github.com",
    "repository": "growthbook/skills",
    "run_id": "local",
}
env = dict(os.environ)
env.update(
    {
        "GITHUB_REPOSITORY": github["repository"],
        "GITHUB_SERVER_URL": github["server_url"],
        "GITHUB_RUN_ID": github["run_id"],
        "GITHUB_EVENT_NAME": os.environ.get("GITHUB_EVENT_NAME", "workflow_dispatch"),
        "RUNNER_TEMP": runner_temp,
        "GITHUB_STEP_SUMMARY": summary,
    }
)
outputs = {}
outcomes = {}
failed = False


def lookup(name):
    if name.startswith("steps."):
        _, sid, kind, *rest = name.split(".")
        if kind == "outcome":
            return outcomes.get(sid, "skipped")
        return outputs.get(sid, {}).get(rest[0], "")
    if name.startswith("inputs."):
        return inputs.get(name[len("inputs."):], "")
    if name.startswith("env."):
        return env.get(name[len("env."):], "")
    if name.startswith("github."):
        return github.get(name[len("github."):], "")
    if name.startswith("runner."):
        return runner_temp if name == "runner.temp" else ""
    if name.startswith("secrets."):
        return "local"
    raise ValueError(f"Unsupported expression: {name}")


def evaluate(expr):
    expr = " ".join(expr.split()).replace("always()", "True")
    py = re.sub(
        r"\b(steps\.[\w-]+\.outcome|steps\.[\w-]+\.outputs\.[\w-]+|inputs\.\w+|env\.\w+|github\.\w+|runner\.\w+|secrets\.\w+)\b",
        lambda m: repr(lookup(m.group(1))),
        expr,
    )
    py = py.replace("&&", " and ").replace("||", " or ")
    return eval(py, {"__builtins__": {}}, {"True": True, "False": False})


def interpolate(value):
    if not isinstance(value, str):
        return value
    return re.sub(r"\$\{\{(.*?)\}\}", lambda m: str(evaluate(m.group(1))), value)


def read_outputs(path):
    text = open(path).read()
    parsed = {}
    for m in re.finditer(r"^(\w+)<<(\w+)\n(.*?)\n\2$", text, re.S | re.M):
        parsed[m.group(1)] = m.group(3)
    text = re.sub(r"^(\w+)<<(\w+)\n.*?\n\2$", "", text, flags=re.S | re.M)
    for line in text.splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            parsed[key] = value
    return parsed


for key, value in workflow.get("env", {}).items():
    env[key] = str(interpolate(value))

for step in workflow["jobs"]["sync"]["steps"]:
    name = step.get("name") or step.get("uses")
    sid = step.get("id")
    cond = step.get("if")
    runs_after_failure = cond is not None and "always()" in cond
    if (failed and not runs_after_failure) or (
        cond is not None and not evaluate(cond)
    ):
        print(f"--- skip  {name}", flush=True)
        if sid:
            outcomes[sid] = "skipped"
        continue
    uses = step.get("uses", "")
    if uses.startswith(
        ("actions/checkout", "actions/setup-node", "actions/upload-artifact")
    ):
        print(f"--- local {name} (prepared by run-local.sh)", flush=True)
        if sid:
            outcomes[sid] = "success"
        continue

    step_env = dict(env)
    for key, value in step.get("env", {}).items():
        step_env[key] = str(interpolate(value))
    out_file = os.path.join(runner_temp, f"output-{sid or 'step'}")
    env_file = os.path.join(runner_temp, "github-env")
    open(out_file, "w").close()
    open(env_file, "w").close()
    step_env["GITHUB_OUTPUT"] = out_file
    step_env["GITHUB_ENV"] = env_file
    cwd = os.path.join(workspace, step.get("working-directory", "."))
    print(f"--- run   {name}", flush=True)

    if uses.startswith("anthropics/claude-code-action"):
        args = {k: interpolate(v) for k, v in step["with"].items()}
        cmd = [
            "claude",
            "-p",
            args["prompt"],
            *shlex.split(args["claude_args"]),
            "--output-format",
            "json",
        ]
        with open(os.path.join(runner_temp, "claude.json"), "w") as fh:
            rc = subprocess.run(cmd, cwd=cwd, env=step_env, stdout=fh).returncode
    else:
        rc = subprocess.run(
            ["bash", "-eo", "pipefail", "-c", step["run"]], cwd=cwd, env=step_env
        ).returncode

    if sid:
        outputs[sid] = read_outputs(out_file)
        outcomes[sid] = "success" if rc == 0 else "failure"
    for line in open(env_file).read().splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            env[key] = value
    if rc != 0:
        tolerated = bool(step.get("continue-on-error"))
        print(
            f"--- fail  {name} (exit {rc}){' (continue-on-error)' if tolerated else ''}",
            flush=True,
        )
        if not tolerated:
            failed = True

print("--- outcomes " + json.dumps(outcomes))
sys.exit(1 if failed else 0)
