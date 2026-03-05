import { execFile } from "node:child_process";
import { promisify } from "node:util";

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
