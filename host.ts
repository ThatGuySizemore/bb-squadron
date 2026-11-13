import { spawn } from "node:child_process";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import { doctorHostContract } from "./lib/doctor-contract.js";

/** Discard command output. Neither tokens nor gh diagnostics cross the host boundary. */
async function githubLogin(signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("gh", ["auth", "status"], {
      shell: false, stdio: "ignore", signal, timeout: 10_000,
    });
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
  });
}

export function createDoctorHost(checkLogin: (signal: AbortSignal) => Promise<boolean> = githubLogin) {
  return experimental_defineHostEntry({
    contract: doctorHostContract,
    handlers: {
      githubLogin: async (_input, { signal }) => {
        try { return { authenticated: await checkLogin(signal) }; }
        catch { return { authenticated: false }; }
      },
    },
  });
}

export default createDoctorHost();
