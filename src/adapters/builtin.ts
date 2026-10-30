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

import { AdapterConfig } from "../dap/types.js";

export const BUILTIN_ADAPTERS: AdapterConfig[] = [
  {
    type: "gdb",
    program: "gdb",
    args: ["--nx", "--quiet", "--interpreter=dap"],
    transport: "stdio",
    installHint: "Install GDB with Python and native DAP support (gdb --interpreter=dap).",
  },
  {
    type: "python",
    runtime: "python3",
    program: "-m",
    args: ["debugpy.adapter"],
    launchDefaults: {
      console: "internalConsole",
    },
    installHint: "pip install debugpy",
  },
  {
    type: "go",
    program: "dlv",
    args: ["dap", "--listen=127.0.0.1:0"],
    transport: "tcp",
    // Matches: "DAP server listening at: 127.0.0.1:38251"
    portMatcher: "DAP server listening at:\\s*\\S+:(\\d+)",
    installHint: "go install github.com/go-delve/delve/cmd/dlv@latest",
  },
  // node adapter: vscode-js-debug's dapDebugServer.js. The user must install
  // it (no universal path); the registry's availability check will mark this
  // unavailable when the program is missing.
  {
    type: "node",
    runtime: "node",
    program: "dapDebugServer.js",
    // Bind to IPv4 explicitly; the default is IPv6 ('::1') which our client
    // (which connects to 127.0.0.1) can't reach on systems without v4↔v6
    // bridging.
    args: ["0", "127.0.0.1"],
    transport: "tcp",
    // Matches: "Debug server listening at 127.0.0.1:38251" (vscode-js-debug)
    portMatcher: "[Ll]istening at\\s*\\S*?:(\\d+)",
    // vscode-js-debug requires these in the launch request; pwa-node is the
    // "production worker agent" Node launcher.
    launchDefaults: {
      type: "pwa-node",
      request: "launch",
    },
    installHint:
      "Install vscode-js-debug DAP server and set the adapter's `program` to its dapDebugServer.js path " +
      "(e.g. via `configure_adapter`). See https://github.com/microsoft/vscode-js-debug.",
  },
  {
    type: "cppdbg",
    program: "lldb-dap",
    args: [],
    installHint: "apt install lldb (Debian/Ubuntu) or brew install llvm (macOS)",
  },
  // php adapter: vscode-php-debug's phpDebug.js. Like node, there is no
  // universal install path, so the user points `program` at it; the
  // launchDefaults below still apply to that override (the registry merges
  // them across tiers).
  {
    type: "php",
    runtime: "node",
    program: "phpDebug.js",
    args: [],
    // The adapter listens on `port` and xdebug connects back to it. Without
    // these runtimeArgs PHP runs to completion before xdebug ever connects,
    // so no breakpoint is hit.
    launchDefaults: {
      port: 9003,
      hostname: "127.0.0.1",
      runtimeArgs: [
        "-dxdebug.mode=debug",
        "-dxdebug.start_with_request=yes",
        "-dxdebug.client_host=127.0.0.1",
        "-dxdebug.client_port=9003",
      ],
    },
    installHint:
      "Install xdebug 3 and vscode-php-debug, then set the adapter's `program` to its out/phpDebug.js path " +
      "(e.g. via `configure_adapter`). See https://github.com/xdebug/vscode-php-debug.",
  },
];
