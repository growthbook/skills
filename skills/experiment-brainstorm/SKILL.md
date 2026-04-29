---
name: experiment-brainstorm
description: Proposes new GrowthBook experiment ideas grounded in the team's past experiment history. Use when the user asks "what should we test next", "give me experiment ideas", "what's worth A/B testing", or wants to brainstorm tests informed by prior results. Reads stopped experiments via the GrowthBook MCP and proposes hypotheses that build on or contrast with observed history. Does not create experiments — proposal only.
when_to_use: User wants ideas for new experiments, grounded in their actual data. Trigger on "what experiments should we run", "give me test ideas", "brainstorm A/B tests", "what's worth testing next", "ideas for experiments". Skip if the user is asking to design one specific test (use experiment-design), to launch an experiment (use experiment-launch), or to read the result of one (use experiment-analyze).
allowed-tools: mcp__growthbook__get_experiments
---

# experiment-brainstorm

Propose new experiment ideas grounded in the team's past stopped experiments. Read history first; propose based on what actually moved metrics, where guardrails failed, and which tags or projects under-explored.

## Workflow

1. **Pull the history.** Call `mcp__growthbook__get_experiments` with `mode: "summary"` and `mostRecent: true`. Summary mode returns aggregate stats over **stopped experiments only** — drafts and running experiments are excluded by design. The output includes:
   - Win rate, average lift, median lift
   - Top 5 winners and top 5 losers (by absolute lift)
   - Breakdowns by project, tag, month, type
   - SRM failure rate and guardrail regression rate
   - Per-experiment cards with verdict, hypothesis, and metrics

2. **Read the patterns.** Before proposing anything, identify three things from the summary:
   - **What's working** — themes shared by the top winners (which projects, which surfaces, which kind of change).
   - **What's stalling** — themes shared by losers and inconclusive tests.
   - **What's under-explored** — projects, tags, or surfaces with few experiments compared to the rest.

3. **Propose 5–7 ideas.** Each proposal contains:
   - **Hypothesis** in one sentence: "If we change X, then Y will improve, because Z."
   - **Why this is grounded** — one sentence linking it to a specific past experiment in the summary (winner to extend, loser to retry differently, gap to fill).
   - **Primary metric** — pick one. State the type (proportion, mean, ratio, quantile) and why.
   - **Expected effect size** — order of magnitude only ("comparable to the +3.2% lift on the checkout flow test"), not a precise number.
   - **Risk to watch** — one guardrail metric or potential regression.

4. **Present with structure.** Lead with the patterns you saw (1–2 lines each), then the proposals. End by asking the user which to refine — do not start designing or creating experiments inside this skill. Hand off to `experiment-design` for the one(s) the user picks.

## Guardrails

- **Summary mode covers stopped experiments only.** Drafts and running experiments are excluded. Don't claim "we've never tried X" if there's a running experiment that does — call `get_experiments` with `mode: "metadata"` separately if the user asks about the live pipeline.
- **Ground every proposal.** Cite the specific past experiment(s) you're building on. No proposals based on generic best practices.
- **Don't repeat losers without saying why.** If a proposal mirrors a recent loser, say so explicitly and explain what's different this time. Otherwise it reads like ignorance of the data.
- **Win rate is `won / (won + lost + inconclusive)`.** That matches GrowthBook's own definition. Don't redefine it.
- **Watch for SRM and guardrail issues in the history.** If the summary reports a high SRM failure rate, mention it and propose at least one idea aimed at improving experiment hygiene rather than another product test.
- **Propose, do not create.** Never call `create_experiment`. The user's next step is `experiment-design` for the proposal they want to pursue.
- **Avoid metric-fishing proposals.** Each idea has one primary metric. Don't propose tests with five metrics hoping one moves — that's the "too many primary metrics" footgun.

## MCP tools used

- `mcp__growthbook__get_experiments` with `mode: "summary"` — aggregate stats over stopped experiments. The summary includes top winners, top losers, and breakdowns this skill relies on.

## Output template

```
## Patterns from your last N stopped experiments

- Working: <theme>
- Stalling: <theme>
- Under-explored: <theme>

## Proposed experiments

### 1. <short title>
- Hypothesis: …
- Grounded in: <past experiment + verdict>
- Primary metric: <name> (<type>)
- Expected effect: <order of magnitude>
- Risk: <guardrail>

…

Pick one or two and I'll hand off to `experiment-design` to scope it.
```
