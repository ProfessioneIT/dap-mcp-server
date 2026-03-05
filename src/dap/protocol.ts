import { DebugProtocol } from "@vscode/debugprotocol";

const TWO_CRLF = "\r\n\r\n";
const CONTENT_LENGTH = "Content-Length: ";

export function encodeMessage(msg: DebugProtocol.ProtocolMessage): Buffer {
  const json = JSON.stringify(msg);
  const header = `${CONTENT_LENGTH}${Buffer.byteLength(json)}${TWO_CRLF}`;
  return Buffer.from(header + json, "utf-8");
}

export class MessageParser {
  private buffer = Buffer.alloc(0);
  private contentLength = -1;
  private onMessage: (msg: DebugProtocol.ProtocolMessage) => void;

  constructor(onMessage: (msg: DebugProtocol.ProtocolMessage) => void) {
    this.onMessage = onMessage;
  }

  feed(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data]);
    this.parse();
  }

  private parse(): void {
    while (true) {
      if (this.contentLength === -1) {
        const headerEnd = this.buffer.indexOf(TWO_CRLF);
        if (headerEnd === -1) return;

        const header = this.buffer.subarray(0, headerEnd).toString("utf-8");
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          this.buffer = this.buffer.subarray(headerEnd + TWO_CRLF.length);
          continue;
        }
        this.contentLength = parseInt(match[1], 10);
        this.buffer = this.buffer.subarray(headerEnd + TWO_CRLF.length);
      }

      if (this.buffer.length < this.contentLength) return;

      const body = this.buffer.subarray(0, this.contentLength).toString("utf-8");
      this.buffer = this.buffer.subarray(this.contentLength);
      this.contentLength = -1;

      try {
        const msg = JSON.parse(body) as DebugProtocol.ProtocolMessage;
        this.onMessage(msg);
      } catch {
        // Skip malformed JSON
      }
    }
  }
}
