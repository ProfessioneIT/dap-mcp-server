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

import { describe, expect, it } from "vitest";
import { StoppedState } from "../dap/types.js";
import { compactState, renderState } from "./state-format.js";

const state: StoppedState = {
  status: "stopped",
  reason: "step",
  location: { file: "/app/main.py", line: 12, column: 1, functionName: "total" },
  threads: [{ id: 1, name: "MainThread", stopped: true }],
  stackTrace: [
    { id: 2, name: "total", file: "/app/main.py", line: 12, column: 1 },
    { id: 3, name: "<module>", file: "/app/main.py", line: 40, column: 5 },
  ],
  scopes: [
    {
      name: "Locals",
      variables: [
        { name: "n", value: "14", type: "int", hasChildren: false, variablesReference: 0 },
        {
          name: "items",
          value: "[1, 2]",
          type: "list",
          hasChildren: true,
          variablesReference: 9,
          children: [{ name: "0", value: "1", type: "", hasChildren: false, variablesReference: 0 }],
        },
      ],
    },
  ],
  omittedScopes: ["Globals"],
  output: ["hello\n"],
};

describe("compactState", () => {
  it("drops fields an agent can do without after a step", () => {
    expect(compactState(state)).toEqual({
      status: "stopped",
      reason: "step",
      location: { file: "/app/main.py", line: 12, functionName: "total" },
      stackTrace: [
        { id: 2, name: "total", file: "/app/main.py", line: 12 },
        { id: 3, name: "<module>", file: "/app/main.py", line: 40 },
      ],
      scopes: [
        {
          name: "Locals",
          variables: [
            { name: "n", value: "14", type: "int" },
            {
              name: "items",
              value: "[1, 2]",
              type: "list",
              variablesReference: 9,
              children: [{ name: "0", value: "1" }],
            },
          ],
        },
      ],
      omittedScopes: ["Globals"],
      output: ["hello\n"],
    });
  });

  it("keeps the thread list when there is more than one thread to tell apart", () => {
    const threads = [
      { id: 1, name: "main", stopped: true },
      { id: 2, name: "worker", stopped: false },
    ];
    expect(compactState({ ...state, threads }).threads).toEqual(threads);
  });

  it("renders compact states without indentation and full states unchanged", () => {
    expect(renderState(state, "compact")).toBe(JSON.stringify(compactState(state)));
    expect(renderState(state, "full")).toBe(JSON.stringify(state, null, 2));
  });
});
