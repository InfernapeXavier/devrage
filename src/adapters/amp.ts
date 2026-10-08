import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Adapter, AdapterOptions, Message, UsageRecord } from "./index";

/**
 * Read legacy local threads (or manually exported JSON). When none exist, use
 * the authenticated Amp CLI to read server-backed threads without persisting them.
 */
const execFileAsync = promisify(execFile);

function getAmpThreadsDir(): string {
  return join(process.env["XDG_DATA_HOME"] ?? join(homedir(), ".local", "share"), "amp", "threads");
}

export function ampAdapter(): Adapter {
  return {
    name: "amp",
    async *messages(options?: AdapterOptions): AsyncGenerator<Message> {
      const role = options?.role ?? "user";

      for await (const { thread, threadId } of readAmpThreads(options)) {
        try {
          if (!thread.messages || !Array.isArray(thread.messages)) {
            continue;
          }

          for (const msg of thread.messages) {
            if (msg.role !== role) {
              continue;
            }

            const text = extractText(msg.content);
            if (!text) {
              continue;
            }

            const timestamp = msg.timestamp ?? msg.createdAt ?? undefined;
            if (options?.since && timestamp) {
              const ts = new Date(timestamp);
              if (ts < options.since) {
                continue;
              }
            }

            yield {
              text,
              timestamp,
              session: threadId,
            };
          }
        } catch {
          // Skip malformed files
        }
      }
    },
    async *usage(options?: AdapterOptions): AsyncGenerator<UsageRecord> {
      for await (const { thread, threadId } of readAmpThreads(options)) {
        try {
          // A ledger and message usage can describe the same requests. Prefer
          // the legacy ledger when it contains records, never count both.
          let records = extractAmpUsageRecords(thread.usageLedger, threadId);
          if (records.length === 0 && Array.isArray(thread.messages)) {
            records = thread.messages.flatMap((msg) =>
              msg?.role === "assistant" && msg.usage
                ? extractAmpUsageRecords(msg.usage, threadId, {
                    timestamp: msg.timestamp ?? msg.createdAt,
                  })
                : [],
            );
          }

          for (const record of records) {
            if (options?.since && record.timestamp) {
              const ts = new Date(record.timestamp);
              if (ts < options.since) {
                continue;
              }
            }

            yield record;
          }
        } catch {
          // Skip malformed files
        }
      }
    },
  };
}

async function* readAmpThreads(
  options?: AdapterOptions,
): AsyncGenerator<{ thread: AmpThread; threadId: string }> {
  const threadsDir = getAmpThreadsDir();
  let files: string[] = [];
  try {
    files = (await readdir(threadsDir)).filter((file) => file.endsWith(".json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("devrage: cannot read local Amp threads; skipping Amp.");
      return;
    }
  }

  if (files.length > 0) {
    for (const file of files) {
      try {
        const thread = JSON.parse(await readFile(join(threadsDir, file), "utf-8"));
        if (asRecord(thread)) {
          yield { thread, threadId: file.slice(0, -5) };
        }
      } catch {
        console.error(`devrage: skipping unreadable Amp thread ${file}.`);
      }
    }
    return;
  }

  const seen = new Set<string>();
  const pageSize = 100;
  for (let offset = 0; ; offset += pageSize) {
    let page: unknown;
    try {
      page = await ampJson([
        "threads",
        "list",
        "--json",
        "--include-archived",
        "--limit",
        String(pageSize),
        "--offset",
        String(offset),
      ]);
      if (!Array.isArray(page)) {
        throw new Error("Unexpected Amp thread list format");
      }
    } catch (error) {
      // Amp is optional when scanning all installed agents.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(
          "devrage: cannot list Amp threads; check `amp threads list --json` and authentication. Results may be incomplete.",
        );
      }
      return;
    }

    let newThreads = 0;
    for (const value of page) {
      const entry = asRecord(value);
      const id = entry?.["id"];
      if (typeof id !== "string" || !/^T-[0-9a-f-]+$/i.test(id) || seen.has(id)) {
        continue;
      }
      seen.add(id);
      newThreads++;
      const updated = entry?.["updated"];
      if (options?.since && typeof updated === "string" && new Date(updated) < options.since) {
        continue;
      }
      try {
        const thread = await ampJson(["threads", "export", id]);
        if (!asRecord(thread)) {
          throw new Error("Unexpected Amp thread format");
        }
        yield { thread: thread as AmpThread, threadId: id };
      } catch {
        console.error(`devrage: could not export Amp thread ${id}; results may be incomplete.`);
      }
    }
    if (page.length < pageSize || newThreads === 0) {
      return;
    }
  }
}

async function ampJson(args: string[]): Promise<unknown> {
  const { stdout } = await execFileAsync("amp", args, {
    encoding: "utf-8",
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

function extractText(content: unknown): string | null {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const parts = content
      .filter(
        (p): p is { type: string; text: string } =>
          typeof p === "object" && p !== null && typeof p.text === "string",
      )
      .map((p) => p.text);
    return parts.length > 0 ? parts.join(" ") : null;
  }
  return null;
}

interface AmpMessage {
  role?: string;
  content?: unknown;
  timestamp?: string;
  createdAt?: string;
  usage?: unknown;
}

interface AmpThread {
  messages?: AmpMessage[];
  usageLedger?: unknown;
}

interface AmpUsageContext {
  provider?: string;
  model?: string;
  timestamp?: string;
}

function extractAmpUsageRecords(
  usageLedger: unknown,
  threadId: string,
  context: AmpUsageContext = {},
): UsageRecord[] {
  const records: UsageRecord[] = [];
  collectAmpUsage(usageLedger, threadId, records, context);
  return records;
}

function collectAmpUsage(
  value: unknown,
  threadId: string,
  records: UsageRecord[],
  context: AmpUsageContext,
  depth = 0,
): void {
  if (depth > 12) {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectAmpUsage(item, threadId, records, context, depth + 1);
    }
    return;
  }

  const record = asRecord(value);
  if (!record) {
    return;
  }

  const nextContext = {
    provider: stringField(record, ["provider", "providerID", "providerId"]) ?? context.provider,
    model: stringField(record, ["model", "modelID", "modelId"]) ?? context.model,
    timestamp: timestampField(record) ?? context.timestamp,
  };
  const usageSource = firstRecordField(record, ["usage", "tokens", "tokenUsage"]) ?? record;
  const rawInputTokens = tokenField(usageSource, ["inputTokens", "input_tokens", "promptTokens"]);
  const outputTokens = tokenField(usageSource, [
    "outputTokens",
    "output_tokens",
    "completionTokens",
  ]);
  const reasoningTokens = tokenField(usageSource, ["reasoningTokens", "reasoning_output_tokens"]);
  const cachedInputSubset = tokenField(usageSource, ["cachedInputTokens", "cached_input_tokens"]);
  const cacheReadTokens = tokenField(usageSource, [
    "cacheReadTokens",
    "cache_read_tokens",
    "cacheReadInputTokens",
    "cache_read_input_tokens",
    "cachedInputTokens",
    "cached_input_tokens",
  ]);
  const inputTokens = Math.max(rawInputTokens - cachedInputSubset, 0);
  const cacheWriteTokens = tokenField(usageSource, [
    "cacheWriteTokens",
    "cache_write_tokens",
    "cacheCreationInputTokens",
    "cache_creation_input_tokens",
    "cacheWriteInputTokens",
    "cache_write_input_tokens",
  ]);
  const billedCost = tokenField(record, [
    "cost",
    "totalCost",
    "total_cost",
    "billedCost",
    "billed_cost",
  ]);

  if (
    inputTokens + outputTokens + reasoningTokens + cacheReadTokens + cacheWriteTokens + billedCost >
    0
  ) {
    records.push({
      agent: "amp",
      provider: nextContext.provider,
      model: nextContext.model,
      timestamp: nextContext.timestamp,
      session: threadId,
      billedCost,
      inputTokens,
      outputTokens,
      reasoningTokens,
      cacheReadTokens,
      cacheWriteTokens,
    });
  }

  for (const child of Object.values(record)) {
    if (child !== usageSource && typeof child === "object" && child !== null) {
      collectAmpUsage(child, threadId, records, nextContext, depth + 1);
    }
  }
}

function firstRecordField(
  record: Record<string, unknown>,
  fields: string[],
): Record<string, unknown> | null {
  for (const field of fields) {
    const value = asRecord(record[field]);
    if (value) {
      return value;
    }
  }

  return null;
}

function stringField(record: Record<string, unknown>, fields: string[]): string | undefined {
  for (const field of fields) {
    const value = record[field];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  return undefined;
}

function timestampField(record: Record<string, unknown>): string | undefined {
  const value = stringField(record, ["timestamp", "createdAt", "time", "date"]);
  if (value) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
  }

  return undefined;
}

function tokenField(record: Record<string, unknown>, fields: string[]): number {
  for (const field of fields) {
    const value = record[field];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }

  return 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}
