/**
 * Copyright (c) 2026 Ivan Iraci <ivan.iraci@professioneit.com>
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

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
let breakpointCount = 0;
let stopOnEntry = false;
let exceptionFilters = [];

function handleMessage(msg) {
  if (msg.type !== "request") return;
  switch (msg.command) {
    case "initialize":
      send({ seq: seq++, type: "response", request_seq: msg.seq, command: "initialize", success: true,
        body: { supportsConfigurationDoneRequest: true, supportsEvaluateForHovers: true, supportsExceptionInfoRequest: true } });
      send({ seq: seq++, type: "event", event: "initialized", body: {} });
      break;
    case "setBreakpoints":
      // "unbound" sources model a debugger that never attaches to the runtime
      // (e.g. PHP without xdebug): unverified, and the program runs past them.
      const unbound = (msg.arguments.source?.path || "").includes("unbound");
      if (!unbound) breakpointCount += (msg.arguments.breakpoints || []).length;
      const provisional = unbound || (msg.arguments.source?.path || "").includes("provisional");
      send({ seq: seq++, type: "response", request_seq: msg.seq, command: "setBreakpoints", success: true,
        body: { breakpoints: (msg.arguments.breakpoints || []).map((bp, i) => ({
          id: i+1,
          verified: !provisional,
          line: provisional ? 0 : bp.line,
          message: provisional ? "breakpoint.provisionalBreakpoint" : undefined,
        })) } });
      break;
    case "setExceptionBreakpoints":
      exceptionFilters = msg.arguments.filters || [];
      send({ seq: seq++, type: "response", request_seq: msg.seq, command: "setExceptionBreakpoints", success: true, body: {} });
      break;
    case "configurationDone":
      send({ seq: seq++, type: "response", request_seq: msg.seq, command: "configurationDone", success: true, body: {} });
      // Real-adapter behavior: after configurationDone, if launch was non-stopOnEntry
      // and breakpoints were set, the program runs and hits the first breakpoint.
      if (!stopOnEntry && breakpointCount > 0) {
        setTimeout(() => { send({ seq: seq++, type: "event", event: "stopped", body: { reason: "breakpoint", threadId: 1, allThreadsStopped: true } }); }, 50);
      } else if (!stopOnEntry && exceptionFilters.length > 0) {
        // Exception breakpoints armed: the program raises and the adapter stops on it.
        setTimeout(() => { send({ seq: seq++, type: "event", event: "stopped", body: { reason: "exception", description: "Paused on exception", text: "ValueError", threadId: 1, allThreadsStopped: true } }); }, 50);
      } else if (!stopOnEntry && breakpointCount === 0) {
        // No breakpoints, no stop-on-entry: program runs to completion and terminates.
        // Like several real adapters, `exited` trails `terminated`.
        setTimeout(() => {
          send({ seq: seq++, type: "event", event: "output", body: { category: "stdout", output: "Program completed\n" } });
          send({ seq: seq++, type: "event", event: "terminated", body: {} });
          setTimeout(() => { send({ seq: seq++, type: "event", event: "exited", body: { exitCode: 3 } }); }, 20);
        }, 50);
      }
      break;
    case "launch":
      currentLine = 1;
      stopOnEntry = !!msg.arguments.stopOnEntry;
      send({ seq: seq++, type: "response", request_seq: msg.seq, command: "launch", success: true, body: {} });
      send({ seq: seq++, type: "event", event: "output", body: { category: "stdout", output: "Program started\n" } });
      if (stopOnEntry) {
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
          { name: "Registers", variablesReference: 400, presentationHint: "registers", expensive: false },
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
      } else if (msg.arguments.variablesReference === 300) {
        send({ seq: seq++, type: "response", request_seq: msg.seq, command: "variables", success: true,
          body: { variables: [
            { name: "0", value: "1", type: "int", variablesReference: 0 },
            { name: "1", value: "2", type: "int", variablesReference: 0 },
            { name: "2", value: "3", type: "int", variablesReference: 0 },
          ] } });
      } else if (msg.arguments.variablesReference === 400) {
        send({ seq: seq++, type: "response", request_seq: msg.seq, command: "variables", success: true,
          body: { variables: [
            { name: "rax", value: "0x0000000000000000", type: "unsigned long", variablesReference: 0 },
            { name: "rip", value: "0x0000000000400473", type: "unsigned long", variablesReference: 0 },
          ] } });
      } else {
        send({ seq: seq++, type: "response", request_seq: msg.seq, command: "variables", success: true, body: { variables: [] } });
      }
      break;
    case "exceptionInfo":
      send({ seq: seq++, type: "response", request_seq: msg.seq, command: "exceptionInfo", success: true,
        body: { exceptionId: "ValueError", description: "bad value", breakMode: "unhandled",
          details: { typeName: "ValueError", message: "bad value", stackTrace: "Traceback (most recent call last): ..." } } });
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
