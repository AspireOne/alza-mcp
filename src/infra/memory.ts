import { readFile } from "node:fs/promises";
import { freemem, totalmem, loadavg } from "node:os";
import { log } from "./logger.js";

const SAMPLE_INTERVAL_MS = 10_000;

/** RSS covers Node only; host and cgroup samples also account for browser memory. */
export function memorySnapshot() {
  const memory = process.memoryUsage();
  return {
    process_rss_bytes: memory.rss, heap_used_bytes: memory.heapUsed,
    heap_total_bytes: memory.heapTotal, external_bytes: memory.external,
    system_total_bytes: totalmem(), system_free_bytes: freemem(),
    process_available_bytes: process.availableMemory(), load_average: loadavg(),
  };
}

async function optionalRead(path: string): Promise<string | null> {
  try { return await readFile(path, "utf8"); } catch { return null; }
}

export async function sampleMemory(): Promise<Record<string, unknown>> {
  const [meminfo, vmstat, pressure, current, limit, swap, events] = await Promise.all([
    optionalRead("/proc/meminfo"), optionalRead("/proc/vmstat"), optionalRead("/proc/pressure/memory"),
    optionalRead("/sys/fs/cgroup/memory.current"), optionalRead("/sys/fs/cgroup/memory.max"),
    optionalRead("/sys/fs/cgroup/memory.swap.current"), optionalRead("/sys/fs/cgroup/memory.events"),
  ]);
  const kib = (name: string) => {
    const value = meminfo?.match(new RegExp(`^${name}:\\s+(\\d+) kB`, "m"))?.[1];
    return value === undefined ? null : Number(value) * 1024;
  };
  const counter = (source: string | null, name: string) => {
    const value = source?.match(new RegExp(`^${name} (\\d+)$`, "m"))?.[1];
    return value === undefined ? null : Number(value);
  };
  const bytes = (value: string | null) => value !== null && /^\d+\s*$/.test(value) ? Number(value.trim()) : null;
  return {
    ...memorySnapshot(),
    system_available_bytes: kib("MemAvailable"), system_swap_total_bytes: kib("SwapTotal"), system_swap_free_bytes: kib("SwapFree"),
    swap_in_pages_total: counter(vmstat, "pswpin"), swap_out_pages_total: counter(vmstat, "pswpout"),
    memory_pressure: pressure?.trim() ?? null,
    cgroup_current_bytes: bytes(current), cgroup_limit_bytes: bytes(limit), cgroup_swap_bytes: bytes(swap),
    cgroup_high_total: counter(events, "high"), cgroup_max_total: counter(events, "max"),
    cgroup_oom_total: counter(events, "oom"), cgroup_oom_kill_total: counter(events, "oom_kill"),
  };
}

export function startMemoryMonitor(): () => void {
  let stopped = false, sampling = false;
  const sample = async () => {
    if (sampling || stopped) return;
    sampling = true;
    try {
      const memory = await sampleMemory();
      if (!stopped) log.info("memory.sample", { memory });
    } catch { if (!stopped) log.warn("memory.sample_failed"); }
    finally { sampling = false; }
  };
  void sample();
  const timer = setInterval(() => void sample(), SAMPLE_INTERVAL_MS);
  timer.unref();
  return () => { stopped = true; clearInterval(timer); };
}
