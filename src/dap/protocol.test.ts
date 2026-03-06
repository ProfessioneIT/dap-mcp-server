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

import { describe, it, expect } from "vitest";
import { encodeMessage, MessageParser } from "./protocol.js";
import { DebugProtocol } from "@vscode/debugprotocol";

describe("encodeMessage", () => {
  it("encodes a DAP message with Content-Length header", () => {
    const msg: DebugProtocol.Request = {
      seq: 1,
      type: "request",
      command: "initialize",
      arguments: { adapterID: "test" },
    };
    const encoded = encodeMessage(msg);
    const str = encoded.toString("utf-8");
    const json = JSON.stringify(msg);
    expect(str).toBe(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
  });
});

describe("MessageParser", () => {
  it("parses a single complete message", () => {
    const messages: DebugProtocol.ProtocolMessage[] = [];
    const parser = new MessageParser((msg) => messages.push(msg));

    const body = JSON.stringify({ seq: 1, type: "response", command: "initialize", success: true, request_seq: 1 });
    const raw = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    parser.feed(Buffer.from(raw));

    expect(messages).toHaveLength(1);
    expect(messages[0].seq).toBe(1);
  });

  it("handles messages split across multiple chunks", () => {
    const messages: DebugProtocol.ProtocolMessage[] = [];
    const parser = new MessageParser((msg) => messages.push(msg));

    const body = JSON.stringify({ seq: 1, type: "event", event: "initialized" });
    const raw = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    const mid = Math.floor(raw.length / 2);

    parser.feed(Buffer.from(raw.slice(0, mid)));
    expect(messages).toHaveLength(0);
    parser.feed(Buffer.from(raw.slice(mid)));
    expect(messages).toHaveLength(1);
  });

  it("handles multiple messages in one chunk", () => {
    const messages: DebugProtocol.ProtocolMessage[] = [];
    const parser = new MessageParser((msg) => messages.push(msg));

    const body1 = JSON.stringify({ seq: 1, type: "event", event: "initialized" });
    const body2 = JSON.stringify({ seq: 2, type: "event", event: "stopped" });
    const raw = `Content-Length: ${Buffer.byteLength(body1)}\r\n\r\n${body1}Content-Length: ${Buffer.byteLength(body2)}\r\n\r\n${body2}`;
    parser.feed(Buffer.from(raw));

    expect(messages).toHaveLength(2);
    expect(messages[0].seq).toBe(1);
    expect(messages[1].seq).toBe(2);
  });
});
