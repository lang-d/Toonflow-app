import type { Namespace, Socket } from "socket.io";
import ResTool from "@/socket/resTool";
import u from "@/utils";
import { getActiveAgentRun, getLatestAgentRun, recordAgentRunEvent } from "@/services/agentRun";

export type SharedAgentSocketScope = {
  projectId: number;
  scriptId: number;
  isolationKey: string;
};

export function sharedAgentRoom(agentKey: string, scope: SharedAgentSocketScope) {
  return `${agentKey}:${scope.projectId}:${scope.scriptId}`;
}

export function sharedAgentRunScope(agentKey: string, scope: SharedAgentSocketScope) {
  return { agentKey, projectId: scope.projectId, scriptId: scope.scriptId };
}

export function sharedAgentRunUpdate(agentKey: string, scope: SharedAgentSocketScope, payload: Record<string, unknown>) {
  return {
    agentKey,
    projectId: scope.projectId,
    scriptId: scope.scriptId,
    serverTime: Date.now(),
    ...payload,
  };
}

export function createSharedAgentResTool(
  nsp: Namespace,
  agentKey: string,
  scope: SharedAgentSocketScope,
  data: Record<string, unknown>,
) {
  return new ResTool(
    {
      emit: (event: string, ...args: any[]) => nsp.to(sharedAgentRoom(agentKey, scope)).emit(event, ...args),
    } as unknown as Socket,
    data,
  );
}

export function createRunStateRestoreBarrier(input: {
  nsp: Namespace;
  socket: Socket;
  agentKey: string;
  scope: SharedAgentSocketScope;
}) {
  const scope = input.scope;
  const promise = (async () => {
    try {
      const activeRun = await getActiveAgentRun(sharedAgentRunScope(input.agentKey, scope));
      if (activeRun) {
        await recordAgentRunEvent(activeRun.runId, "client_resumed", {
          socketId: input.socket.id,
          isolationKey: scope.isolationKey,
        });
        input.socket.emit(
          "agent:run:update",
          sharedAgentRunUpdate(input.agentKey, scope, { status: activeRun.status, activeRun, resumed: true }),
        );
        return { scope, error: null as Error | null };
      }
      const latestRun = await getLatestAgentRun(sharedAgentRunScope(input.agentKey, scope));
      if (latestRun) {
        input.socket.emit(
          "agent:run:update",
          sharedAgentRunUpdate(input.agentKey, scope, {
            status: latestRun.status,
            run: latestRun,
            latestRun,
            resumed: false,
            terminal: latestRun.status !== "running",
          }),
        );
      }
      return { scope, error: null as Error | null };
    } catch (error) {
      return { scope, error: u.error(error) };
    }
  })();

  return {
    scope,
    promise,
    async wait(expectedScope: SharedAgentSocketScope = scope) {
      const result = await promise;
      if (result.scope.isolationKey !== expectedScope.isolationKey) {
        throw new Error(`${input.agentKey} context changed while restoring run state`);
      }
      if (result.error) throw result.error;
    },
  };
}
