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

import { StoppedState, Variable } from "../dap/types.js";

export type StateDetail = "compact" | "full";

/** Stack depth worth paying for on every step; get_state can ask for more. */
export const COMPACT_STACK_DEPTH = 5;

function compactVariable(variable: Variable): Record<string, unknown> {
  return {
    name: variable.name,
    value: variable.value,
    type: variable.type || undefined,
    variablesReference: variable.variablesReference > 0 ? variable.variablesReference : undefined,
    children: variable.children?.map(compactVariable),
  };
}

/**
 * The token-frugal view of a stopped state: no columns, no redundant
 * variable bookkeeping, and no thread list unless there are threads to tell
 * apart. Undefined members disappear on JSON serialization.
 */
export function compactState(state: StoppedState): Record<string, unknown> {
  const { column: _column, ...location } = state.location;
  const compact = {
    status: state.status,
    reason: state.reason,
    exception: state.exception,
    location,
    threads: state.threads.length > 1 ? state.threads : undefined,
    stackTrace: state.stackTrace.map(({ column: _frameColumn, ...frame }) => frame),
    scopes: state.scopes.map((scope) => ({
      name: scope.name,
      variables: scope.variables.map(compactVariable),
    })),
    omittedScopes: state.omittedScopes,
    output: state.output,
    outputOmitted: state.outputOmitted,
  };
  return JSON.parse(JSON.stringify(compact)) as Record<string, unknown>;
}

export function renderState(
  state: StoppedState,
  detail: StateDetail,
  extra: Record<string, unknown> = {}
): string {
  return detail === "compact"
    ? JSON.stringify({ ...extra, ...compactState(state) })
    : JSON.stringify({ ...extra, ...state }, null, 2);
}
