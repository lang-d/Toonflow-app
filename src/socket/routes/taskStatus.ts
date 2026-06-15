import type { Namespace, Socket } from "socket.io";
import db from "@/utils/db";
import { formatTaskEvent } from "@/services/taskCoordinator";
import { verifyAuthToken } from "@/services/authToken";

export default (nsp: Namespace) => {
  let lastEventId = 0;
  let clients = 0;
  let polling = false;

  void (db as any)("o_taskEvent")
    .max("id as id")
    .first()
    .then((row: any) => {
      lastEventId = Number(row?.id || 0);
    });

  nsp.on("connection", async (socket: Socket) => {
    const token = String(socket.handshake.auth.token || socket.handshake.query.token || "");
    if (!(await verifyAuthToken(token))) {
      socket.disconnect();
      return;
    }
    clients += 1;
    socket.on("disconnect", () => {
      clients = Math.max(0, clients - 1);
    });
  });

  const timer = setInterval(async () => {
    if (!clients || polling) return;
    polling = true;
    try {
      const rows = await (db as any)("o_taskEvent").where("id", ">", lastEventId).orderBy("id", "asc").limit(500);
      for (const row of rows) {
        lastEventId = Math.max(lastEventId, Number(row.id));
        nsp.emit("task:status", formatTaskEvent(row));
      }
    } catch (error) {
      console.warn("[task-status] event polling failed:", String(error));
    } finally {
      polling = false;
    }
  }, 500);
  timer.unref();
};
