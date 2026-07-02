#!/usr/bin/env node
/**
 * Crypto Market MCP Server — HTTP entry point (для деплоя в облако).
 *
 * Использует stateless-режим Streamable HTTP: каждый запрос обрабатывается
 * независимо, без хранения сессий.
 *
 * Авторизация: интерфейс custom connector в Claude на момент написания не
 * поддерживает статичные Bearer-токены (только OAuth или её отсутствие).
 * Полноценный OAuth избыточен для сервера, который отдаёт только публичные
 * рыночные данные без побочных эффектов. Вместо токена используется
 * простой rate limiting по IP — защита от злоупотребления, а не от доступа
 * как такового.
 */

import express from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { TOOLS, callTool } from "./tools.js";

const PORT = process.env.PORT || 3000;

// -------------------- Простой rate limiter (без внешних зависимостей) --------------------

const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 минута
const RATE_LIMIT_MAX_REQUESTS = 30; // запросов в минуту с одного IP
const requestLog = new Map(); // ip -> [timestamps]

function isRateLimited(ip) {
  const now = Date.now();
  const timestamps = (requestLog.get(ip) || []).filter(
    (t) => now - t < RATE_LIMIT_WINDOW_MS
  );
  timestamps.push(now);
  requestLog.set(ip, timestamps);
  return timestamps.length > RATE_LIMIT_MAX_REQUESTS;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of requestLog.entries()) {
    const fresh = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (fresh.length === 0) requestLog.delete(ip);
    else requestLog.set(ip, fresh);
  }
}, RATE_LIMIT_WINDOW_MS).unref();

function createServer() {
  const server = new Server(
    { name: "crypto-market-mcp", version: "1.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    try {
      const result = await callTool(name, args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  });

  return server;
}

const app = express();
app.use(express.json());

// Health check — для проверки хостингом (Render/Railway/Fly.io) и вручную
app.get("/health", (req, res) => {
  res.json({ status: "ok", server: "crypto-market-mcp", version: "1.1.0" });
});

// Основной MCP-эндпоинт (stateless streamable HTTP)
app.post("/mcp", async (req, res) => {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip;
  if (isRateLimited(ip)) {
    res.status(429).json({ error: "Too many requests, slow down." });
    return;
  }
  try {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// GET/DELETE на /mcp не поддерживаются в stateless-режиме без сессий
app.get("/mcp", (req, res) => {
  res.status(405).json({ error: "Method not allowed in stateless mode" });
});
app.delete("/mcp", (req, res) => {
  res.status(405).json({ error: "Method not allowed in stateless mode" });
});

app.listen(PORT, () => {
  console.log(`crypto-market-mcp HTTP server listening on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
  console.log(`Auth: none (public read-only data) — rate limited to ${RATE_LIMIT_MAX_REQUESTS} req/min per IP`);
});
