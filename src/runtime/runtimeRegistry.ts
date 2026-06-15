import type { RuntimeMetric } from "@/runtime/runtimeMetrics";
import type { RuntimeSupervisorSnapshot } from "@/runtime/runtimeProtocol";

const metrics = new Map<string, RuntimeMetric>();
const ports = new Map<string, { port: any; pid: number; onMessage: (event: any) => void }>();
const portListeners = new Map<string, Set<(port: any | null, pid: number) => void>>();
let supervisorSnapshot: RuntimeSupervisorSnapshot | null = null;

export function updateRuntimeMetric(metric: RuntimeMetric) {
  metrics.set(metric.role, metric);
}

export function getRuntimeMetrics() {
  return [...metrics.values()].sort((a, b) => a.role.localeCompare(b.role));
}

export function attachRuntimePort(port: any, role = "unknown", pid = 0) {
  const existing = ports.get(role);
  if (existing) {
    existing.port.off?.("message", existing.onMessage);
    existing.port.close?.();
  }
  const onMessage = (event: any) => {
    const data = event?.data ?? event;
    if (data?.type === "runtime:metric" && data.metric) updateRuntimeMetric(data.metric);
  };
  ports.set(role, { port, pid, onMessage });
  port.on("message", onMessage);
  port.start?.();
  for (const listener of portListeners.get(role) || []) listener(port, pid);
}

export function getRuntimePort(role: string) {
  return ports.get(role)?.port;
}

export function getRuntimeConnections() {
  return [...ports.entries()]
    .map(([role, item]) => ({ role, pid: item.pid, connected: true }))
    .sort((a, b) => a.role.localeCompare(b.role));
}

export function onRuntimePortChanged(role: string, listener: (port: any | null, pid: number) => void) {
  const listeners = portListeners.get(role) || new Set<(port: any | null, pid: number) => void>();
  listeners.add(listener);
  portListeners.set(role, listeners);
  const current = ports.get(role);
  if (current) listener(current.port, current.pid);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) portListeners.delete(role);
  };
}

export function setRuntimeSupervisorSnapshot(snapshot: RuntimeSupervisorSnapshot) {
  supervisorSnapshot = snapshot;
}

export function getRuntimeSupervisorSnapshot() {
  return supervisorSnapshot;
}

export function closeRuntimePorts() {
  for (const [role, item] of ports) {
    item.port.off?.("message", item.onMessage);
    item.port.close?.();
    for (const listener of portListeners.get(role) || []) listener(null, 0);
  }
  ports.clear();
}
