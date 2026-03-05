// src/dap/types.ts

export type SessionState = "idle" | "configuring" | "running" | "stopped" | "terminated";

export interface StoppedState {
  status: "stopped";
  reason: string;
  location: {
    file: string;
    line: number;
    column?: number;
    functionName?: string;
  };
  threads: Array<{ id: number; name: string; stopped: boolean }>;
  stackTrace: Array<{
    id: number;
    name: string;
    file: string;
    line: number;
    column?: number;
  }>;
  scopes: Array<{
    name: string;
    variables: Array<{
      name: string;
      value: string;
      type?: string;
      hasChildren: boolean;
      variablesReference: number;
    }>;
  }>;
  output?: string[];
}

export interface RunningState {
  status: "running";
  output?: string[];
  elapsedMs?: number;
}

export type DebugState = StoppedState | RunningState;

export interface AdapterConfig {
  type: string;
  runtime?: string;
  program: string;
  args?: string[];
  launchDefaults?: Record<string, unknown>;
  installHint?: string;
}

export interface OutputEntry {
  category: string;
  text: string;
  timestamp: string;
}

export interface BreakpointConfig {
  line: number;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
}

export interface BreakpointResult {
  id: number;
  verified: boolean;
  line: number;
  message?: string;
}
