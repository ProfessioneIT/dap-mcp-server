import { AdapterConfig } from "../dap/types.js";

export const BUILTIN_ADAPTERS: AdapterConfig[] = [
  {
    type: "python",
    runtime: "python3",
    program: "-m",
    args: ["debugpy.adapter"],
    installHint: "pip install debugpy",
  },
  {
    type: "node",
    runtime: "node",
    program: "",
    args: [],
    installHint: "npm install -g @vscode/js-debug",
  },
  {
    type: "go",
    program: "dlv",
    args: ["dap"],
    installHint: "go install github.com/go-delve/delve/cmd/dlv@latest",
  },
  {
    type: "cppdbg",
    program: "lldb-dap",
    args: [],
    installHint: "apt install lldb (Debian/Ubuntu) or brew install llvm (macOS)",
  },
];
