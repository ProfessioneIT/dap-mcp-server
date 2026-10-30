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

import { writeFileSync } from "node:fs";

const mode = process.argv.find((arg) => arg.startsWith("--mode="))?.slice(7) ?? "ready";
const pidFile = process.argv.find((arg) => arg.startsWith("--pid-file="))?.slice(11);
if (pidFile) writeFileSync(pidFile, String(process.pid));
if (mode === "exit") process.exit(1);
let buffer = Buffer.alloc(0);
let sequence = 1;
let variableTypes = false;
let configured = false;
let line = 5;
let source = "/test/app.rs";
let nextBreakpoint = 1;
const breakpoints = new Map();
const send = (message) => {
  const json = JSON.stringify({ seq: sequence++, ...message });
  process.stdout.write("Content-Length: " + Buffer.byteLength(json) + "\r\n\r\n" + json);
};
const event = (name, body) => send({ type: "event", event: name, body });
const response = (request, body = {}, message) => send({
  type: "response", request_seq: request.seq, command: request.command,
  success: message === undefined, body, ...(message ? { message } : {}),
});
function finish() {
  event("output", { category: "stdout", output: "Program completed\n" });
  event("exited", { exitCode: 0 });
  event("terminated", {});
}
function stop(reason = "breakpoint") {
  event("stopped", { reason, threadId: 1, allThreadsStopped: true });
}
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const split = buffer.indexOf("\r\n\r\n");
    if (split < 0) return;
    const length = Number(buffer.subarray(0, split).toString().match(/Content-Length:\s*(\d+)/i)?.[1]);
    if (buffer.length < split + 4 + length) return;
    const request = JSON.parse(buffer.subarray(split + 4, split + 4 + length).toString());
    buffer = buffer.subarray(split + 4 + length);
    handle(request);
  }
});
function handle(request) {
  const args = request.arguments ?? {};
  switch (request.command) {
    case "initialize":
      if (mode === "silent") return;
      if (mode === "cli") { process.stdout.write("GNU gdb without DAP\n"); return; }
      if (mode === "malformed") { process.stdout.write("Content-Length: 1\r\n\r\n{"); return; }
      if (mode === "reject") { response(request, {}, "DAP initialization rejected"); return; }
      variableTypes = args.supportsVariableType === true;
      response(request, { supportsConfigurationDoneRequest: true, supportsConditionalBreakpoints: true });
      event("initialized", {});
      break;
    case "launch":
      if (String(args.program).endsWith(".rs")) { response(request, {}, "Cannot launch a Rust source file"); return; }
      response(request);
      event("output", { category: "console", output: JSON.stringify({ launch: args }) + "\n" });
      break;
    case "attach":
      if (args.pid !== 42) { response(request, {}, "GDB expects pid=42"); return; }
      response(request);
      event("output", { category: "console", output: JSON.stringify({ attach: args }) + "\n" });
      break;
    case "setBreakpoints": {
      source = args.source.path;
      const values = args.breakpoints.map((bp) => ({ id: nextBreakpoint++, verified: configured, line: configured ? bp.line : 0 }));
      breakpoints.set(source, args.breakpoints.map((bp, index) => ({ ...values[index], line: bp.line })));
      if (args.breakpoints.length) line = args.breakpoints[0].line;
      response(request, { breakpoints: values });
      break;
    }
    case "configurationDone":
      configured = true;
      response(request);
      for (const [file, values] of breakpoints) {
        for (const bp of values) event("breakpoint", { reason: "changed", breakpoint: { ...bp, verified: true, source: { path: file } } });
      }
      setTimeout(() => [...breakpoints.values()].some((values) => values.length) ? stop() : finish(), 10);
      break;
    case "threads":
      response(request, { threads: [{ id: 1, name: "main" }] });
      break;
    case "stackTrace":
      response(request, { stackFrames: [{ id: 0, name: "water_balance", source: { path: source }, line, column: 1 }], totalFrames: 1 });
      break;
    case "scopes":
      response(request, { scopes: [{ name: "Locals", variablesReference: 1, expensive: false }] });
      break;
    case "variables":
      response(request, { variables: [{ name: "x", value: "42", variablesReference: 0, ...(variableTypes ? { type: "i32" } : {}) }] });
      break;
    case "evaluate":
      if (args.context === "repl") {
        if (args.expression === "print x") response(request, { result: "$1 = 42", variablesReference: 0 });
        else response(request, {}, "Undefined command: " + args.expression);
      } else if (args.frameId !== 0) response(request, {}, "Expected frame ID zero");
      else if (args.expression === "bad") response(request, {}, "Unknown variable");
      else response(request, { result: "42", variablesReference: 0, ...(variableTypes ? { type: "i32" } : {}) });
      break;
    case "next":
      response(request); line++; setTimeout(() => stop("step"), 10); break;
    case "continue":
      response(request);
      setTimeout(() => [...breakpoints.values()].some((values) => values.length) ? stop() : finish(), 10);
      break;
    case "disconnect":
      response(request); setTimeout(() => process.exit(0), 5); break;
    default:
      response(request);
  }
}
