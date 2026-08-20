import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";

/**
 * Minimal Agent Client Protocol (ACP) client.
 *
 * ACP is newline-delimited JSON-RPC 2.0 over the agent's stdin/stdout. We use it so engines
 * that support it (hermes acp, opencode acp) can be kept **resident**: the expensive CLI
 * cold start happens once per session instead of once per turn.
 *
 * Only the surface agentd needs is implemented: initialize / session.new / session.load /
 * session.prompt / session.cancel, plus the reverse calls an agent makes back at the client
 * (permission requests and file IO) which are answered with safe defaults.
 */
export type AcpNotification = { method: string; params: Record<string, unknown> };

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void };

export class AcpClient {
  private readonly child: ChildProcess;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private closed = false;
  private stderrTail = "";
  private onNotify: (event: AcpNotification) => void = () => {};

  constructor(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) {
    this.child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (chunk: string) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-8_192);
    });
    const rl = readline.createInterface({ input: this.child.stdout!, crlfDelay: Infinity });
    rl.on("line", (line) => this.handleLine(line));
    this.child.once("exit", (code, signal) => {
      this.closed = true;
      const error = new Error(`ACP agent exited (code=${String(code)}, signal=${String(signal)}): ${this.stderrTail.slice(-400)}`);
      for (const [, pending] of this.pending) pending.reject(error);
      this.pending.clear();
    });
  }

  get alive(): boolean {
    return !this.closed && this.child.exitCode === null && this.child.signalCode === null;
  }

  onNotification(handler: (event: AcpNotification) => void): void {
    this.onNotify = handler;
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: any;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return; // agents sometimes print stray banner lines on stdout
    }
    if (typeof message !== "object" || message === null) return;

    if (message.id !== undefined && message.method) {
      void this.answerAgentRequest(message);
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error?.message || `ACP error ${JSON.stringify(message.error).slice(0, 200)}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method) {
      this.onNotify({ method: message.method, params: message.params || {} });
    }
  }

  /**
   * Answers the calls an agent makes back at us. Permission prompts are auto-approved with the
   * agent's own "allow" option — a turn started through agentd has already been authorized by
   * the caller, and leaving the prompt unanswered would hang the turn forever.
   */
  private async answerAgentRequest(message: any): Promise<void> {
    const method = String(message.method || "");
    let result: unknown = {};
    if (method === "session/request_permission") {
      const options = Array.isArray(message.params?.options) ? message.params.options : [];
      const allow =
        options.find((option: any) => /allow|approve|yes/i.test(String(option?.optionId || option?.kind || ""))) ||
        options[0];
      result = allow?.optionId
        ? { outcome: { outcome: "selected", optionId: allow.optionId } }
        : { outcome: { outcome: "cancelled" } };
    } else if (method === "fs/read_text_file" || method === "fs/write_text_file") {
      // We advertise no fs capability, so an agent should not ask; answer with an explicit error
      // instead of silence so it fails fast rather than hanging.
      this.send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "fs capability not offered" } });
      return;
    }
    this.send({ jsonrpc: "2.0", id: message.id, result });
  }

  private send(payload: Record<string, unknown>): void {
    if (!this.alive) return;
    this.child.stdin?.write(`${JSON.stringify(payload)}\n`);
  }

  async request<T = any>(method: string, params: Record<string, unknown>, timeoutMs = 1_800_000): Promise<T> {
    if (!this.alive) throw new Error("ACP agent process is not running");
    const id = this.nextId++;
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP request ${method} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  kill(): void {
    if (!this.alive) return;
    this.child.kill("SIGTERM");
    setTimeout(() => {
      if (this.alive) this.child.kill("SIGKILL");
    }, 3_000).unref();
  }
}
