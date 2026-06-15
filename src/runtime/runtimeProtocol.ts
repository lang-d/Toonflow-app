export type RuntimeRole = "api" | "worker" | "agent";
export type RuntimeStatus = "starting" | "ready" | "degraded" | "stopped" | "failed";

export interface RuntimeServiceState {
  role: RuntimeRole;
  pid: number;
  status: RuntimeStatus;
  lastHeartbeatAt: number;
  restartCount: number;
  lastError?: string;
  ipcConnected?: boolean;
}

export interface RuntimeSupervisorSnapshot {
  apiUrl: string;
  updatedAt: number;
  services: RuntimeServiceState[];
}

export type RuntimeMessage =
  | { type: "runtime:ready"; role: RuntimeRole; pid: number; port?: number }
  | { type: "runtime:heartbeat"; role: RuntimeRole; pid: number; timestamp: number }
  | { type: "runtime:stopped"; role: RuntimeRole; pid: number }
  | { type: "runtime:error"; role: RuntimeRole; pid: number; message: string }
  | { type: "runtime:supervisor"; snapshot: RuntimeSupervisorSnapshot };

export const RUNTIME_API_HOST = "127.0.0.1";
export const RUNTIME_API_PORT = 10588;
export const RUNTIME_API_URL = `http://${RUNTIME_API_HOST}:${RUNTIME_API_PORT}/api`;

export function startRuntimeHeartbeat(role: RuntimeRole, publish: (message: RuntimeMessage) => void) {
  const send = () => publish({ type: "runtime:heartbeat", role, pid: process.pid, timestamp: Date.now() });
  send();
  const timer = setInterval(send, 5_000);
  timer.unref();
  return () => clearInterval(timer);
}
