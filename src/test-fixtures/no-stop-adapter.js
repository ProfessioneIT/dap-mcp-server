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

// Mock adapter that completes the DAP handshake but never emits stopped events.
// Used to test client behavior when a breakpoint is never hit (e.g. timeout paths).

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
  if (msg.type !== "request") return;
  switch (msg.command) {
    case "initialize":
      send({ seq: seq++, type: "response", request_seq: msg.seq, command: "initialize", success: true,
        body: { supportsConfigurationDoneRequest: true } });
      send({ seq: seq++, type: "event", event: "initialized", body: {} });
      break;
    case "setBreakpoints":
      send({ seq: seq++, type: "response", request_seq: msg.seq, command: "setBreakpoints", success: true,
        body: { breakpoints: (msg.arguments.breakpoints || []).map((bp, i) => ({ id: i+1, verified: true, line: bp.line })) } });
      break;
    case "disconnect":
      send({ seq: seq++, type: "response", request_seq: msg.seq, command: "disconnect", success: true, body: {} });
      setTimeout(() => process.exit(0), 20);
      break;
    default:
      send({ seq: seq++, type: "response", request_seq: msg.seq, command: msg.command, success: true, body: {} });
  }
}
