import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";

import type { RuntimeAgentSupervisor } from "./supervisor.js";
import { errorMessage } from "./util.js";

const JSON_LIMIT_BYTES = 2 * 1024 * 1024;

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > JSON_LIMIT_BYTES) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function matches(pathname: string, pattern: RegExp): RegExpMatchArray | undefined {
  return pathname.match(pattern) ?? undefined;
}

function authorized(request: IncomingMessage, token: string): boolean {
  if (!token) return true;
  return request.headers.authorization === `Bearer ${token}`;
}

export function createHttpServer(supervisor: RuntimeAgentSupervisor): http.Server {
  return http.createServer(async (request, response) => {
    try {
      if (!authorized(request, supervisor.config.internalToken)) {
        json(response, 401, { error: "unauthorized" });
        return;
      }
      const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
      const method = request.method || "GET";
      if (method === "GET" && url.pathname === "/health") {
        json(response, 200, supervisor.healthSnapshot());
        return;
      }
      if (method === "GET" && url.pathname === "/v1/adapters") {
        json(response, 200, { adapters: supervisor.listAdapters() });
        return;
      }
      if (method === "GET" && url.pathname === "/v1/providers") {
        json(response, 200, { providers: await supervisor.providers.list() });
        return;
      }
      if (method === "POST" && url.pathname === "/v1/adapters/probe") {
        json(response, 200, { adapters: await supervisor.probeAdapters() });
        return;
      }
      if (method === "POST" && url.pathname === "/v1/executions") {
        const result = await supervisor.submit(await readJson(request));
        json(response, result.created ? 202 : 200, result);
        return;
      }
      if (method === "GET" && url.pathname === "/v1/executions") {
        json(response, 200, { executions: supervisor.listExecutions(Number(url.searchParams.get("limit") || 50)) });
        return;
      }

      const executionMatch = matches(url.pathname, /^\/v1\/executions\/([^/]+)$/u);
      if (method === "GET" && executionMatch) {
        const execution = supervisor.getExecution(decodeURIComponent(executionMatch[1] || ""));
        if (!execution) json(response, 404, { error: "not_found" });
        else json(response, 200, { execution });
        return;
      }
      const cancelMatch = matches(url.pathname, /^\/v1\/executions\/([^/]+)\/cancel$/u);
      if (method === "POST" && cancelMatch) {
        json(response, 200, { execution: await supervisor.cancel(decodeURIComponent(cancelMatch[1] || "")) });
        return;
      }
      const eventsMatch = matches(url.pathname, /^\/v1\/executions\/([^/]+)\/events$/u);
      if (method === "GET" && eventsMatch) {
        const executionId = decodeURIComponent(eventsMatch[1] || "");
        const acceptsSse = request.headers.accept?.includes("text/event-stream") === true;
        const afterId = Number(request.headers["last-event-id"] || url.searchParams.get("after") || 0);
        if (!acceptsSse) {
          json(response, 200, { events: supervisor.listEvents(executionId, afterId) });
          return;
        }
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        const writeEvent = (event: ReturnType<RuntimeAgentSupervisor["listEvents"]>[number]): void => {
          response.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        };
        const replay = supervisor.listEvents(executionId, afterId);
        replay.forEach(writeEvent);
        const current = supervisor.getExecution(executionId);
        if (current && supervisor.isTerminal(current.status)) {
          response.end();
          return;
        }
        const unsubscribe = supervisor.events.subscribe(executionId, (event) => {
          writeEvent(event);
          if (supervisor.isTerminal(event.status)) {
            unsubscribe();
            response.end();
          }
        });
        const keepAlive = setInterval(() => response.write(": keepalive\n\n"), 15_000);
        keepAlive.unref();
        request.once("close", () => {
          clearInterval(keepAlive);
          unsubscribe();
        });
        return;
      }
      const artifactMatch = matches(url.pathname, /^\/v1\/executions\/([^/]+)\/artifacts\/([^/]+)$/u);
      if (method === "GET" && artifactMatch) {
        const execution = supervisor.getExecution(decodeURIComponent(artifactMatch[1] || ""));
        const artifact = execution?.artifacts.find((item) => item.id === decodeURIComponent(artifactMatch[2] || ""));
        if (!execution || !artifact) {
          json(response, 404, { error: "not_found" });
          return;
        }
        const resolved = path.resolve(artifact.path);
        if (!resolved.startsWith(`${path.resolve(execution.outputDir)}${path.sep}`) && resolved !== path.resolve(execution.outputDir)) {
          throw new Error("Artifact path escaped the execution output directory");
        }
        response.writeHead(200, {
          "content-type": artifact.mediaType,
          "content-length": String(artifact.size),
          "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(artifact.name)}`,
        });
        fs.createReadStream(resolved).pipe(response);
        return;
      }
      json(response, 404, { error: "not_found" });
    } catch (error) {
      json(response, 400, { error: "request_failed", message: errorMessage(error) });
    }
  });
}
