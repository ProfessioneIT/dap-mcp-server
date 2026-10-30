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

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { AdapterConfig } from "../dap/types.js";
import { DAPClient } from "../dap/dap-client.js";

const execFileAsync = promisify(execFile);

export async function checkAdapterAvailable(command: string): Promise<boolean> {
  try {
    const whichCmd = process.platform === "win32" ? "where" : "which";
    await execFileAsync(whichCmd, [command]);
    return true;
  } catch {
    return false;
  }
}

export interface AdapterAvailability {
  available: boolean;
  command: string;
  reason?: string;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate the complete adapter command, not just its runtime. This prevents
 * configurations such as `node missing-adapter.js` from being reported as
 * available merely because Node itself is installed.
 */
export async function inspectAdapterAvailability(
  config: AdapterConfig
): Promise<AdapterAvailability> {
  const command = config.runtime || config.program;
  if (config.transport === "tcp") {
    if (!config.portMatcher) {
      return {
        available: false,
        command,
        reason: "TCP adapters require a portMatcher with one capture group for the listening port.",
      };
    }
    try {
      new RegExp(config.portMatcher);
    } catch {
      return {
        available: false,
        command,
        reason: `The configured portMatcher is not a valid regular expression: ${config.portMatcher}`,
      };
    }
  }
  if (!(await checkAdapterAvailable(command))) {
    return {
      available: false,
      command,
      reason: `Executable '${command}' was not found on PATH.`,
    };
  }

  if (config.type === "gdb") {
    const fullCommand = [config.runtime, config.program, ...(config.args ?? [])].filter(Boolean).join(" ");
    const client = new DAPClient(config.runtime ?? "", config.program, config.args ?? [], {
      transport: config.transport,
      portMatcher: config.portMatcher,
      tcpConnectTimeout: 2000,
    });
    try {
      await client.spawn();
      await client.sendRequest("initialize", {
        adapterID: "gdb", clientID: "dap-mcp-server-readiness",
        linesStartAt1: true, columnsStartAt1: true, pathFormat: "path",
      }, 2000);
      return { available: true, command: fullCommand };
    } catch (err) {
      return {
        available: false, command: fullCommand,
        reason: `GDB DAP initialization failed: ${err instanceof Error ? err.message : String(err)}. Use a GDB build with Python/DAP support and --interpreter=dap.`,
      };
    } finally {
      await client.dispose();
    }
  }

  if (!config.runtime) {
    return { available: true, command };
  }

  if (config.program === "-m") {
    const moduleName = config.args?.[0];
    if (!moduleName) {
      return {
        available: false,
        command,
        reason: "The adapter uses '-m' but no module name is configured.",
      };
    }
    try {
      await execFileAsync(config.runtime, [
        "-c",
        "import importlib.util,sys; sys.exit(0 if importlib.util.find_spec(sys.argv[1]) else 1)",
        moduleName,
      ]);
      return { available: true, command: `${config.runtime} -m ${moduleName}` };
    } catch {
      return {
        available: false,
        command: `${config.runtime} -m ${moduleName}`,
        reason: `Python module '${moduleName}' is not installed for '${config.runtime}'.`,
      };
    }
  }

  const looksLikeScript =
    path.isAbsolute(config.program) ||
    /[\\/]/.test(config.program) ||
    /\.(?:cjs|js|mjs|py|jar)$/i.test(config.program);
  if (!looksLikeScript) {
    return { available: true, command };
  }

  const resolved = path.resolve(config.program);
  if (await fileExists(resolved)) {
    return { available: true, command: `${config.runtime} ${resolved}` };
  }
  if (await checkAdapterAvailable(config.program)) {
    return { available: true, command: `${config.runtime} ${config.program}` };
  }
  return {
    available: false,
    command: `${config.runtime} ${config.program}`,
    reason: `Adapter program '${config.program}' was not found.`,
  };
}
