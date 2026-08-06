import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";

import type { RuntimeAgentSupervisor } from "./supervisor.js";
import { errorMessage, SupervisorError } from "./util.js";

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
      if (method === "GET" && url.pathname === "/v1/status") {
        json(response, 200, supervisor.statusSnapshot());
        return;
      }
      if (method === "POST" && url.pathname === "/v1/sessions") {
        const result = await supervisor.createSession(await readJson(request));
        json(response, result.created ? 201 : 200, result);
        return;
      }
      if (method === "GET" && url.pathname === "/v1/sessions") {
        json(response, 200, {
          sessions: supervisor.listSessions(
            Number(url.searchParams.get("limit") || 50),
            url.searchParams.get("instanceId") || undefined,
          ),
        });
        return;
      }
      const sessionCloseMatch = matches(url.pathname, /^\/v1\/sessions\/([^/]+)\/close$/u);
      if (method === "POST" && sessionCloseMatch) {
        json(response, 200, { session: await supervisor.closeSession(decodeURIComponent(sessionCloseMatch[1] || "")) });
        return;
      }
      const sessionProviderMatch = matches(url.pathname, /^\/v1\/sessions\/([^/]+)\/provider$/u);
      if (method === "POST" && sessionProviderMatch) {
        json(response, 200, await supervisor.setSessionProvider(
          decodeURIComponent(sessionProviderMatch[1] || ""),
          await readJson(request),
        ));
        return;
      }
      const sessionTurnsMatch = matches(url.pathname, /^\/v1\/sessions\/([^/]+)\/turns$/u);
      if (method === "POST" && sessionTurnsMatch) {
        const result = await supervisor.createTurn(
          decodeURIComponent(sessionTurnsMatch[1] || ""),
          await readJson(request),
        );
        json(response, result.created ? 202 : 200, result);
        return;
      }
      const sessionExecutionsMatch = matches(url.pathname, /^\/v1\/sessions\/([^/]+)\/executions$/u);
      if (method === "GET" && sessionExecutionsMatch) {
        json(response, 200, {
          executions: supervisor.listSessionExecutions(
            decodeURIComponent(sessionExecutionsMatch[1] || ""),
            Number(url.searchParams.get("limit") || 200),
          ),
        });
        return;
      }
      const sessionMatch = matches(url.pathname, /^\/v1\/sessions\/([^/]+)$/u);
      if (method === "GET" && sessionMatch) {
        const session = supervisor.getSession(decodeURIComponent(sessionMatch[1] || ""));
        if (!session) json(response, 404, { error: "not_found" });
        else json(response, 200, { session });
        return;
      }
      if (method === "POST" && url.pathname === "/v1/executions") {
        const result = await supervisor.submit(await readJson(request));
        json(response, result.created ? 202 : 200, result);
        return;
      }
      if (method === "GET" && url.pathname === "/v1/events") {
        const acceptsSse = request.headers.accept?.includes("text/event-stream") === true;
        const afterId = Number(request.headers["last-event-id"] || url.searchParams.get("after") || 0);
        if (!acceptsSse) {
          json(response, 200, { events: supervisor.listAllEvents(afterId) });
          return;
        }
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        const writeEvent = (event: ReturnType<RuntimeAgentSupervisor["listAllEvents"]>[number]): void => {
          response.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        };
        let cursor = afterId;
        for (const event of supervisor.listAllEvents(afterId)) {
          writeEvent(event);
          cursor = event.id;
        }
        const unsubscribe = supervisor.events.subscribeAll((event) => {
          if (event.id <= cursor) return;
          cursor = event.id;
          writeEvent(event);
        });
        const keepAlive = setInterval(() => response.write(": keepalive\n\n"), 15_000);
        keepAlive.unref();
        request.once("close", () => {
          clearInterval(keepAlive);
          unsubscribe();
        });
        return;
      }
      const steerMatch = matches(url.pathname, /^\/v1\/executions\/([^/]+)\/steer$/u);
      if (method === "POST" && steerMatch) {
        json(response, 200, {
          execution: await supervisor.steer(decodeURIComponent(steerMatch[1] || ""), await readJson(request)),
        });
        return;
      }
      const approvalMatch = matches(url.pathname, /^\/v1\/executions\/([^/]+)\/approval$/u);
      if (method === "POST" && approvalMatch) {
        json(response, 200, {
          execution: await supervisor.resolveApproval(decodeURIComponent(approvalMatch[1] || ""), await readJson(request)),
        });
        return;
      }
      const waitMatch = matches(url.pathname, /^\/v1\/executions\/([^/]+)\/wait$/u);
      if (method === "GET" && waitMatch) {
        const timeoutMs = Math.min(Math.max(Number(url.searchParams.get("timeoutMs") || 30_000), 1_000), 120_000);
        json(response, 200, await supervisor.waitForTerminal(decodeURIComponent(waitMatch[1] || ""), timeoutMs));
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
      const status = error instanceof SupervisorError ? error.httpStatus : 400;
      json(response, status, { error: "request_failed", message: errorMessage(error) });
    }
  });
}
