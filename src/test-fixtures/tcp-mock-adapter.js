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

// TCP-mode mock DAP adapter for testing the TCP transport.
// Opens a TCP listener on a random port, prints the listen address banner to
// stdout (matching the regex "DAP server listening at: \S+:(\d+)"), accepts a
// single client connection, and runs a tiny DAP server on it.

import net from "node:net";

const TWO_CRLF = "\r\n\r\n";

const server = net.createServer((socket) => {
  let buffer = Buffer.alloc(0);
  let contentLength = -1;
  let seq = 1;

  const send = (msg) => {
    const json = JSON.stringify(msg);
    const header = `Content-Length: ${Buffer.byteLength(json)}${TWO_CRLF}`;
    socket.write(header + json);
  };

  socket.on("data", (chunk) => {
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
      const msg = JSON.parse(body);
      if (msg.type === "request" && msg.command === "initialize") {
        send({
          seq: seq++,
          type: "response",
          request_seq: msg.seq,
          command: msg.command,
          success: true,
          body: { supportsConfigurationDoneRequest: true },
        });
        send({ seq: seq++, type: "event", event: "initialized" });
      } else if (msg.type === "request") {
        send({
          seq: seq++,
          type: "response",
          request_seq: msg.seq,
          command: msg.command,
          success: true,
        });
      }
    }
  });
});

server.listen(0, "127.0.0.1", () => {
  const { address, port } = server.address();
  // Print the listen banner in the same shape delve uses.
  process.stdout.write(`DAP server listening at: ${address}:${port}\n`);
});
