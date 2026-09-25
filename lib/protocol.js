/* Tiny NDJSON helper for the OmniVM control socket. */

export function wire(socket, onMessage, onEnd) {
  let buf = "";
  socket.setEncoding("utf8");
  socket.on("data", chunk => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      onMessage(msg, socket);
    }
  });
  if (onEnd) socket.on("close", onEnd);
  socket.on("error", () => {});
}

export function send(socket, obj) {
  if (socket && !socket.destroyed) socket.write(JSON.stringify(obj) + "\n");
}
