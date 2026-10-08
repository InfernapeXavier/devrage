import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ampAdapter } from "../dist/lib/adapters/amp.js";

const since = new Date("2026-10-01T00:00:00.000Z");
const timestamp = "2026-10-02T03:04:05.000Z";
const usage = {
  model: "amp-fixture",
  inputTokens: 13,
  outputTokens: 29,
  totalInputTokens: 131,
  cacheReadInputTokens: 101,
  cacheCreationInputTokens: 17,
};
const thread = {
  messages: [
    { role: "user", content: "old", createdAt: "2026-09-01T00:00:00.000Z" },
    { role: "user", content: [{ type: "text", text: "hello" }], createdAt: timestamp },
    { role: "assistant", content: [{ type: "text", text: "answer" }], createdAt: timestamp, usage },
  ],
};

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "devrage-amp-adapter-"));
  const oldPath = process.env.PATH;
  const oldDataHome = process.env.XDG_DATA_HOME;
  process.env.PATH = root;
  process.env.XDG_DATA_HOME = join(root, "data");
  t.after(async () => {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = oldDataHome;
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function collect(iterable) {
  const result = [];
  for await (const value of iterable) result.push(value);
  return result;
}

test("Amp CLI fallback paginates, includes archived threads, filters dates and reads message usage", async (t) => {
  const root = await fixture(t);
  // A full first page of old threads must not prevent reading a newer thread
  // on page two. Duplicate IDs and a failed export must not duplicate/drop it.
  const firstPage = Array.from({ length: 100 }, (_, i) => ({
    id: `T-${i}`,
    updated: "2026-09-01T00:00:00.000Z",
  }));
  await writeFile(
    join(root, "amp"),
    `#!${process.execPath}
const args = process.argv.slice(2);
if (args[1] === "list" && args.includes("--json") && args.includes("--include-archived")) {
  const offset = Number(args[args.indexOf("--offset") + 1]);
  console.log(JSON.stringify(offset === 0 ? ${JSON.stringify(firstPage)} : [
    { id: "T-bad", updated: "${timestamp}" },
    { id: "T-abc", updated: "${timestamp}" },
    { id: "T-abc", updated: "${timestamp}" }
  ]));
} else if (args[1] === "export" && args[2] === "T-abc") {
  console.log(${JSON.stringify(JSON.stringify(thread))});
} else { process.exit(1); }
`,
    { mode: 0o755 },
  );
  const warnings = [];
  t.mock.method(console, "error", (message) => warnings.push(message));

  assert.deepEqual(await collect(ampAdapter().messages({ since })), [
    { text: "hello", timestamp, session: "T-abc" },
  ]);
  assert.deepEqual(await collect(ampAdapter().messages({ since, role: "assistant" })), [
    { text: "answer", timestamp, session: "T-abc" },
  ]);
  assert.deepEqual(await collect(ampAdapter().usage({ since })), [
    {
      agent: "amp",
      provider: undefined,
      model: "amp-fixture",
      timestamp,
      session: "T-abc",
      billedCost: 0,
      inputTokens: 13,
      outputTokens: 29,
      reasoningTokens: 0,
      cacheReadTokens: 101,
      cacheWriteTokens: 17,
    },
  ]);
  assert.ok(warnings.some((message) => message.includes("T-bad")));
});

test("Amp local exports remain offline, filter message usage dates, and do not double-count a ledger", async (t) => {
  const root = await fixture(t);
  const dir = join(root, "data", "amp", "threads");
  await mkdir(dir, { recursive: true });
  const local = {
    messages: [
      ...thread.messages,
      {
        role: "assistant",
        createdAt: "2026-09-01T00:00:00.000Z",
        usage,
      },
    ],
  };
  await writeFile(join(dir, "local.json"), JSON.stringify(local));
  assert.equal((await collect(ampAdapter().usage({ since }))).length, 1);
  assert.equal((await collect(ampAdapter().usage())).length, 2);
  local.usageLedger = {
    entries: [{ model: "ledger-fixture", timestamp, usage: { inputTokens: 7 } }],
  };
  await writeFile(join(dir, "local.json"), JSON.stringify(local));
  const records = await collect(ampAdapter().usage({ since }));
  assert.equal(records.length, 1);
  assert.equal(records[0].inputTokens, 7);
  assert.equal(records[0].model, "ledger-fixture");
});

test("Amp is optional, but CLI authentication or protocol failures warn instead of silently appearing empty", async (t) => {
  const root = await fixture(t);
  const warnings = [];
  t.mock.method(console, "error", (message) => warnings.push(message));
  assert.deepEqual(await collect(ampAdapter().messages()), []);
  assert.equal(warnings.length, 0);
  for (const body of ["process.exit(1)", "console.log('{}')"]) {
    await writeFile(join(root, "amp"), `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
    assert.deepEqual(await collect(ampAdapter().messages()), []);
    assert.match(warnings.at(-1), /cannot list Amp threads/);
  }
});
