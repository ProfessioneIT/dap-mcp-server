const TWO_CRLF = "\r\n\r\n";
let buffer = Buffer.alloc(0);
let contentLength = -1;

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    if (contentLength === -1) {
      const idx = buffer.indexOf(TWO_CRLF);
      if (idx === -1) return;
      const header = buffer.subarray(0, idx).toString();
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) return;
      contentLength = parseInt(match[1], 10);
      buffer = buffer.subarray(idx + TWO_CRLF.length);
    }
    if (buffer.length < contentLength) return;
    const body = buffer.subarray(0, contentLength).toString();
    buffer = buffer.subarray(contentLength);
    contentLength = -1;
    handleMessage(JSON.parse(body));
  }
});

function send(msg) {
  const json = JSON.stringify(msg);
  const header = `Content-Length: ${Buffer.byteLength(json)}${TWO_CRLF}`;
  process.stdout.write(header + json);
}

let seq = 1;
function handleMessage(msg) {
  if (msg.type === "request") {
    if (msg.command === "initialize") {
      send({
        seq: seq++, type: "response", request_seq: msg.seq,
        command: "initialize", success: true,
        body: { supportsConfigurationDoneRequest: true }
      });
      send({ seq: seq++, type: "event", event: "initialized", body: {} });
    } else if (msg.command === "disconnect") {
      send({
        seq: seq++, type: "response", request_seq: msg.seq,
        command: "disconnect", success: true
      });
      process.exit(0);
    } else {
      send({
        seq: seq++, type: "response", request_seq: msg.seq,
        command: msg.command, success: true, body: {}
      });
    }
  }
}
