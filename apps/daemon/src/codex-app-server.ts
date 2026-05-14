import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import type { ClientRequest, InitializeResponse, ServerNotification, ServerRequest } from "@armorer/gauntlet-codex-protocol";
import { WebSocket } from "ws";
import { errorMessage, log } from "./logger.js";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export class CodexAppServer extends EventEmitter<{
  notification: [ServerNotification & { method: string; params?: unknown }];
  request: [ServerRequest & { id: string | number; method: string; params?: unknown }];
}> {
  private process?: ReturnType<typeof spawn>;
  private socket?: WebSocket;
  private requestId = 1;
  private readonly pending = new Map<string | number, PendingRequest>();

  async start(): Promise<InitializeResponse> {
    const url = await this.spawnServer();
    await this.connect(url);
    return (await this.request("initialize", {
      clientInfo: {
        name: "armorer-gauntlet-daemon",
        title: "Armorer Gauntlet Daemon",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: []
      }
    })) as InitializeResponse;
  }

  stop(): void {
    this.socket?.close();
    this.process?.kill("SIGTERM");
  }

  async request<M extends ClientRequest["method"]>(method: M, params: unknown): Promise<unknown> {
    const id = this.requestId;
    this.requestId += 1;
    const payload: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params
    };
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Codex app-server socket is not open");
    }
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    socket.send(JSON.stringify(payload));
    return promise;
  }

  respond(id: string | number, result: unknown): void {
    this.send({
      jsonrpc: "2.0",
      id,
      result
    });
  }

  respondError(id: string | number, code: number, message: string): void {
    this.send({
      jsonrpc: "2.0",
      id,
      error: { code, message }
    });
  }

  private async spawnServer(): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn("codex", ["app-server", "--listen", "ws://127.0.0.1:0"], {
        stdio: ["ignore", "pipe", "pipe"]
      });
      this.process = child;
      let settled = false;
      let buffer = "";

      const onData = (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const match = buffer.match(/listening on:\s+(ws:\/\/127\.0\.0\.1:\d+)/);
        if (match?.[1] && !settled) {
          settled = true;
          resolve(match[1]);
        }
      };

      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.once("error", (error) => {
        if (!settled) reject(error);
      });
      child.once("exit", (code) => {
        if (!settled) {
          reject(new Error(`codex app-server exited before becoming ready (code ${code})`));
        }
      });

      setTimeout(() => {
        if (!settled) {
          reject(new Error("Timed out waiting for codex app-server to print its websocket URL"));
        }
      }, 10_000);
    });
  }

  private async connect(url: string): Promise<void> {
    const socket = new WebSocket(url);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.on("message", (raw) => this.handleMessage(raw.toString()));
    socket.on("error", (error) => {
      log.error("codex app-server socket error", errorMessage(error));
    });
    socket.on("close", (code, reason) => {
      log.warn("codex app-server socket closed", { code, reason: reason?.toString(), pendingRequests: this.pending.size });
      for (const pending of this.pending.values()) {
        pending.reject(new Error("Codex app-server socket closed"));
      }
      this.pending.clear();
    });
  }

  private handleMessage(raw: string): void {
    const message = JSON.parse(raw) as JsonRpcResponse | JsonRpcRequest | (ServerNotification & { method: string });
    if ("id" in message && "method" in message) {
      this.emit("request", message as ServerRequest & { id: string | number; method: string; params?: unknown });
      return;
    }
    if ("id" in message) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if ("error" in message && message.error) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if ("method" in message) {
      this.emit("notification", message as ServerNotification & { method: string; params?: unknown });
    }
  }

  private send(message: JsonRpcResponse): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Codex app-server socket is not open");
    }
    socket.send(JSON.stringify(message));
  }
}
