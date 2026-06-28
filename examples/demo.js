/**
 * demo.js — loop-sdk demo: error handling, events, checkpointing
 *
 * Showcases:
 *   1. Step-level retries with backoff
 *   2. Step-level onError fallback
 *   3. skipOnError — non-critical steps that shouldn't abort the loop
 *   4. Loop-level onError — cleanup/alerting when the loop ultimately fails
 *   5. RetryPlugin — global retry for all steps
 *   6. Events — step:complete, step:error, draft:ready (custom + async gate)
 *   7. Checkpointing + resumption
 *
 * No browser daemon needed — MockSession handles browser calls.
 *
 * Usage:
 *   npm run build && node examples/demo.js
 */

import { Loop, claudeCli, checkpointExists, RetryPlugin } from "../dist/index.js";
import { MockSession } from "./mock-session.js";

const CHECKPOINT = "./.loop/demo.checkpoint.json";

// ── Failure simulation helpers ────────────────────────────────────────────────

let flakyAttempts = 0;
async function flakyFetch() {
  flakyAttempts++;
  if (flakyAttempts < 3) throw new Error(`network timeout (attempt ${flakyAttempts})`);
  return "live data fetched on attempt " + flakyAttempts;
}

// ── Loop setup ────────────────────────────────────────────────────────────────

const loop = new Loop("research-loop");

// ── Events ───────────────────────────────────────────────────────────────────

loop.on("loop:start", ({ totalSteps }) => {
  console.log(`[event] loop:start — ${totalSteps} steps`);
});

loop.on("step:complete", ({ step, durationMs }) => {
  console.log(`[event] step:complete  "${step}" in ${durationMs}ms`);
});

loop.on("step:error", ({ step, error }) => {
  console.error(`[event] step:error  "${step}" — ${error.message}`);
});

loop.on("loop:complete", ({ status, durationMs, stepsCompleted }) => {
  console.log(
    `[event] loop:complete  ${status} — ${stepsCompleted} steps ran in ${durationMs}ms`,
  );
});

// Async human-in-the-loop gate: step is PAUSED until this resolves
loop.on("draft:ready", async ({ text, chars }) => {
  console.log(`\n[event] draft:ready — ${chars} chars. Sending for human review...`);
  console.log(`        "${text.slice(0, 80)}..."`);
  console.log("        Waiting for approval (simulated 2s delay)...");
  await new Promise((resolve) => setTimeout(resolve, 2000));
  console.log("        ✓ Approved. Step will now continue.\n");
});

// ── Global retry plugin ───────────────────────────────────────────────────────
// Retries any failing step up to 3 times with a 500ms flat delay.
// Per-step `retries` options run first; the plugin picks up anything still failing.

loop.use(
  RetryPlugin({
    attempts: 3,
    delay: 300,
    backoff: "flat",
    retryIf: (err) => err.message.includes("network"),
  }),
);

// ── Steps ─────────────────────────────────────────────────────────────────────

// 1. Step-level retries with exponential backoff
//    Fails twice, succeeds on the 3rd attempt.
loop.step(
  "fetch-data",
  async (ctx) => {
    const data = await flakyFetch();
    ctx.set("raw-data", data);
  },
  { retries: 3, retryDelay: 200, retryBackoff: "exponential" },
);

// 2. Non-critical step — skip on failure instead of aborting
//    In a real loop this might be metrics, analytics, or a cache warm.
loop.step(
  "post-metrics",
  async (_ctx) => {
    throw new Error("metrics endpoint unreachable");
  },
  { skipOnError: true },
);

// 3. Step with an onError fallback
//    The enrichment service always fails here; the fallback uses cached data.
loop.step(
  "enrich-data",
  async (_ctx) => {
    throw new Error("enrichment service unavailable");
  },
  {
    onError: async (_err, ctx) => {
      ctx.set("enriched", "fallback: using last-known-good cache");
    },
  },
);

// 4. Ask claude for a summary, emit a custom event for human review
loop.step("summarize", async (ctx) => {
  const enriched = ctx.get("enriched");
  const result = await claudeCli(
    ctx,
    `In one sentence, summarize what this data represents: "${enriched}"`,
  );
  ctx.set("summary", result.output);

  // Custom event — pauses the step until all listeners resolve
  await ctx.emit("draft:ready", {
    text: result.output,
    chars: result.output.length,
  });

  console.log("\n── Final summary ──");
  console.log(ctx.get("summary"));
});

// ── Loop-level onError ────────────────────────────────────────────────────────
// Called only if the loop ultimately fails (after all retries and fallbacks).

async function handleLoopFailure(err, ctx, failedStep) {
  console.error(`\n[onError] Loop failed at "${failedStep}": ${err.message}`);
  console.error(
    `[onError] Partial state: ${JSON.stringify(ctx.snapshot(), null, 2)}`,
  );
  // In a real app: await slack.alert(...), await savePartialResults(ctx), etc.
}

// ── Run ───────────────────────────────────────────────────────────────────────

const session = new MockSession("demo");
const isResume = checkpointExists(CHECKPOINT);

if (isResume) {
  console.log(`Found checkpoint at ${CHECKPOINT} — resuming.\n`);
}

await loop.run({
  session,
  checkpointFile: CHECKPOINT,
  resumeFrom: isResume ? CHECKPOINT : null,
  keepCheckpointOnSuccess: true,
  onError: handleLoopFailure,
});
