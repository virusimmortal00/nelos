export function parseCodexJsonl(stdout) {
  const events = [];
  for (const line of stdout.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { events.push({ type: "unparseable-event" }); }
  }
  const usage = events.filter(({ type }) => type === "turn.completed").at(-1)?.usage ?? {};
  const items = events.filter(({ type }) => type === "item.completed" || type === "item.failed");
  const toolItems = items.filter(({ item }) => ["command_execution", "mcp_tool_call", "file_change", "web_search"].includes(item?.type));
  return {
    eventCounts: Object.fromEntries([...new Set(events.map(({ type }) => type ?? "unknown"))].sort().map((type) => [type, events.filter((event) => (event.type ?? "unknown") === type).length])),
    inputTokens: Number(usage.input_tokens ?? 0),
    cachedInputTokens: Number(usage.cached_input_tokens ?? 0),
    outputTokens: Number(usage.output_tokens ?? 0),
    reasoningOutputTokens: Number(usage.reasoning_output_tokens ?? usage.output_tokens_details?.reasoning_tokens ?? 0),
    toolCalls: toolItems.length,
    toolFailures: toolItems.filter(({ type, item }) => type === "item.failed" || item?.status === "failed").length,
  };
}

export function parseProcessTime(stderr) {
  const match = /NELOS_TIME user_seconds=([0-9.]+) system_seconds=([0-9.]+) max_rss_kb=([0-9]+)/u.exec(stderr);
  return match ? { cpuMs: Math.round((Number(match[1]) + Number(match[2])) * 1000), peakMemoryBytes: Number(match[3]) * 1024 } : {};
}

function bytes(value) {
  const match = /^([0-9.]+)(B|kB|MB|GB)$/u.exec(value.trim());
  if (!match) return null;
  return Math.round(Number(match[1]) * ({ B: 1, kB: 1000, MB: 1_000_000, GB: 1_000_000_000 }[match[2]]));
}

export function parseContainerStats(stdout) {
  const stats = JSON.parse(stdout.trim());
  const total = (field) => String(stats[field] ?? "").split("/").map(bytes).filter(Number.isFinite).reduce((sum, value) => sum + value, 0);
  return { networkBytes: total("NetIO"), diskBytes: total("BlockIO") };
}
