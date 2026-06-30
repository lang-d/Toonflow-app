import type { RuntimeMetric } from "./runtimeMetrics";

export type RuntimeActivityKind = "heartbeat" | "stdout" | "stderr" | "metric";

export interface RuntimeWatchdogInput {
  now: number;
  lastHeartbeatAt: number;
  lastStdoutAt?: number;
  lastStderrAt?: number;
  lastMetricAt?: number;
  killThresholdMs: number;
}

export interface RuntimeWatchdogDecision {
  kill: boolean;
  heartbeatAge: number;
  lastActivityAt: number;
  lastActivityKind: RuntimeActivityKind;
  lastActivityAge: number;
}

export function evaluateRuntimeWatchdog(input: RuntimeWatchdogInput): RuntimeWatchdogDecision {
  const heartbeatAt = Number(input.lastHeartbeatAt || input.now);
  const candidates: Array<{ kind: RuntimeActivityKind; at: number }> = [
    { kind: "heartbeat", at: heartbeatAt },
    { kind: "stdout", at: Number(input.lastStdoutAt || 0) },
    { kind: "stderr", at: Number(input.lastStderrAt || 0) },
    { kind: "metric", at: Number(input.lastMetricAt || 0) },
  ];
  const latest = candidates.reduce((best, item) => (item.at > best.at ? item : best), candidates[0]);
  const heartbeatAge = input.now - heartbeatAt;
  const lastActivityAge = input.now - latest.at;
  return {
    kill: heartbeatAge > input.killThresholdMs && lastActivityAge > input.killThresholdMs,
    heartbeatAge,
    lastActivityAt: latest.at,
    lastActivityKind: latest.kind,
    lastActivityAge,
  };
}

export function buildRuntimeWatchdogDiagnostics(input: {
  now: number;
  lastHeartbeatAt?: number;
  lastStdoutAt?: number;
  lastStderrAt?: number;
  lastMetricAt?: number;
  lastMetric?: RuntimeMetric;
}) {
  const age = (value?: number) => (value ? input.now - value : null);
  const metric = input.lastMetric;
  return {
    lastHeartbeatAt: input.lastHeartbeatAt || null,
    lastHeartbeatAge: age(input.lastHeartbeatAt),
    lastStdoutAt: input.lastStdoutAt || null,
    lastStdoutAge: age(input.lastStdoutAt),
    lastStderrAt: input.lastStderrAt || null,
    lastStderrAge: age(input.lastStderrAt),
    lastMetricAt: input.lastMetricAt || null,
    lastMetricAge: age(input.lastMetricAt),
    eventLoopDelayP95Ms: metric?.eventLoopDelayP95Ms,
    eventLoopDelayMaxMs: metric?.eventLoopDelayMaxMs,
    eventLoopUtilization: metric?.eventLoopUtilization,
    rss: metric?.rss,
    heapUsed: metric?.heapUsed,
    database: metric?.database,
    externalProcesses: metric?.externalProcesses,
    activeTasks: metric?.activeTasks,
  };
}
