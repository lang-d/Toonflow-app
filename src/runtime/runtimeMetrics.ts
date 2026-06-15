import { monitorEventLoopDelay, performance } from "node:perf_hooks";

export interface RuntimeMetric {
  role: "main" | "api" | "worker" | "agent";
  pid: number;
  timestamp: number;
  uptimeSec: number;
  eventLoopDelayP95Ms: number;
  eventLoopDelayMaxMs: number;
  eventLoopUtilization: number;
  cpuUserMs: number;
  cpuSystemMs: number;
  rss: number;
  heapUsed: number;
  external: number;
  database?: Record<string, unknown>;
  externalProcesses?: Array<{ pid: number; command: string; startedAt: number }>;
}

export function startRuntimeMetrics(role: RuntimeMetric["role"], publish: (metric: RuntimeMetric) => void) {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  let previousCpu = process.cpuUsage();
  let previousElu = performance.eventLoopUtilization();
  const collect = () => {
    const memory = process.memoryUsage();
    const cpu = process.cpuUsage(previousCpu);
    previousCpu = process.cpuUsage();
    const elu = performance.eventLoopUtilization(previousElu);
    previousElu = performance.eventLoopUtilization();
    const metric: RuntimeMetric = {
      role,
      pid: process.pid,
      timestamp: Date.now(),
      uptimeSec: Math.round(process.uptime()),
      eventLoopDelayP95Ms: Number((histogram.percentile(95) / 1e6).toFixed(2)),
      eventLoopDelayMaxMs: Number((histogram.max / 1e6).toFixed(2)),
      eventLoopUtilization: Number(elu.utilization.toFixed(4)),
      cpuUserMs: Number((cpu.user / 1000).toFixed(2)),
      cpuSystemMs: Number((cpu.system / 1000).toFixed(2)),
      rss: memory.rss,
      heapUsed: memory.heapUsed,
      external: memory.external,
    };
    histogram.reset();
    publish(metric);
  };
  collect();
  const timer = setInterval(collect, 5000);
  timer.unref();
  return () => {
    clearInterval(timer);
    histogram.disable();
  };
}
