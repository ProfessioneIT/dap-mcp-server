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
let currentLine = 1;

function handleMessage(msg) {
  if (msg.type !== "request") return;
  switch (msg.command) {
    case "initialize":
      send({ seq: seq++, type: "response", request_seq: msg.seq, command: "initialize", success: true,
        body: { supportsConfigurationDoneRequest: true, supportsEvaluateForHovers: true } });
      send({ seq: seq++, type: "event", event: "initialized", body: {} });
      break;
    case "setBreakpoints":
      send({ seq: seq++, type: "response", request_seq: msg.seq, command: "setBreakpoints", success: true,
        body: { breakpoints: (msg.arguments.breakpoints || []).map((bp, i) => ({ id: i+1, verified: true, line: bp.line })) } });
      break;
    case "setExceptionBreakpoints":
      send({ seq: seq++, type: "response", request_seq: msg.seq, command: "setExceptionBreakpoints", success: true, body: {} });
      break;
    case "configurationDone":
      send({ seq: seq++, type: "response", request_seq: msg.seq, command: "configurationDone", success: true, body: {} });
      break;
    case "launch":
      currentLine = 1;
      send({ seq: seq++, type: "response", request_seq: msg.seq, command: "launch", success: true, body: {} });
      send({ seq: seq++, type: "event", event: "output", body: { category: "stdout", output: "Program started\n" } });
      if (msg.arguments.stopOnEntry) {
        setTimeout(() => { send({ seq: seq++, type: "event", event: "stopped", body: { reason: "entry", threadId: 1, allThreadsStopped: true } }); }, 50);
      }
      break;
    case "threads":
      send({ seq: seq++, type: "response", request_seq: msg.seq, command: "threads", success: true,
        body: { threads: [{ id: 1, name: "MainThread" }] } });
      break;
    case "stackTrace":
      send({ seq: seq++, type: "response", request_seq: msg.seq, command: "stackTrace", success: true,
        body: { stackFrames: [
          { id: 1, name: "main", source: { path: "/test/app.py" }, line: currentLine, column: 1 },
          { id: 2, name: "helper", source: { path: "/test/utils.py" }, line: 10, column: 1 },
        ], totalFrames: 2 } });
      break;
    case "scopes":
      send({ seq: seq++, type: "response", request_seq: msg.seq, command: "scopes", success: true,
        body: { scopes: [
          { name: "Locals", variablesReference: 100, expensive: false },
          { name: "Globals", variablesReference: 200, expensive: true },
        ] } });
      break;
    case "variables":
      if (msg.arguments.variablesReference === 100) {
        send({ seq: seq++, type: "response", request_seq: msg.seq, command: "variables", success: true,
          body: { variables: [
            { name: "x", value: "42", type: "int", variablesReference: 0 },
            { name: "name", value: "'hello'", type: "str", variablesReference: 0 },
            { name: "data", value: "[1, 2, 3]", type: "list", variablesReference: 300 },
          ] } });
      } else {
        send({ seq: seq++, type: "response", request_seq: msg.seq, command: "variables", success: true, body: { variables: [] } });
      }
      break;
    case "evaluate":
      send({ seq: seq++, type: "response", request_seq: msg.seq, command: "evaluate", success: true,
        body: { result: "42", type: "int", variablesReference: 0 } });
      break;
    case "continue":
      send({ seq: seq++, type: "response", request_seq: msg.seq, command: "continue", success: true, body: { allThreadsContinued: true } });
      currentLine += 5;
      setTimeout(() => { send({ seq: seq++, type: "event", event: "stopped", body: { reason: "breakpoint", threadId: 1, allThreadsStopped: true } }); }, 50);
      break;
    case "next":
      send({ seq: seq++, type: "response", request_seq: msg.seq, command: "next", success: true, body: {} });
      currentLine++;
      setTimeout(() => { send({ seq: seq++, type: "event", event: "stopped", body: { reason: "step", threadId: 1, allThreadsStopped: true } }); }, 50);
      break;
    case "stepIn":
      send({ seq: seq++, type: "response", request_seq: msg.seq, command: "stepIn", success: true, body: {} });
      currentLine++;
      setTimeout(() => { send({ seq: seq++, type: "event", event: "stopped", body: { reason: "step", threadId: 1, allThreadsStopped: true } }); }, 50);
      break;
    case "stepOut":
      send({ seq: seq++, type: "response", request_seq: msg.seq, command: "stepOut", success: true, body: {} });
      setTimeout(() => { send({ seq: seq++, type: "event", event: "stopped", body: { reason: "step", threadId: 1, allThreadsStopped: true } }); }, 50);
      break;
    case "disconnect":
      send({ seq: seq++, type: "response", request_seq: msg.seq, command: "disconnect", success: true, body: {} });
      setTimeout(() => process.exit(0), 50);
      break;
    default:
      send({ seq: seq++, type: "response", request_seq: msg.seq, command: msg.command, success: true, body: {} });
  }
}
