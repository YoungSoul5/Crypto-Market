#!/usr/bin/env node
/**
 * Crypto Market MCP Server — HTTP entry point (для деплоя в облако).
 *
 * Позволяет подключить этот сервер как удалённый (remote) MCP-коннектор в
 * Claude — то есть он будет виден и в Cowork, и в claude.ai, и в Claude Code,
 * а не только в среде, где локально запущен процесс.
 *
 * Использует stateless-режим Streamable HTTP: каждый запрос обрабатывается
 * независимо, без хранения сессий — это подходит нашим read-only
 * инструментам и упрощает деплой (не нужен sticky routing/хранилище сессий).
 *
 * Авторизация: простой Bearer-токен через переменную окружения MCP_AUTH_TOKEN.
 * Если переменная не задана, сервер стартует БЕЗ авторизации — удобно для
 * локальной проверки, но для деплоя в интернет обязательно задайте токен.
 */

import express from "express";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { TOOLS, callTool } from "./tools.js";

const PORT = process.env.PORT || 3000;
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || null;

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

function checkAuth(req, res) {
  if (!AUTH_TOKEN) return true; // авторизация выключена
  const header = req.headers["authorization"] || "";
  const expected = `Bearer ${AUTH_TOKEN}`;
  if (header !== expected) {
    res.status(401).json({ error: "Unauthorized: missing or invalid Bearer token" });
    return false;
  }
  return true;
}

// Основной MCP-эндпоинт (stateless streamable HTTP)
app.post("/mcp", async (req, res) => {
  if (!checkAuth(req, res)) return;
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
  console.log(`Auth: ${AUTH_TOKEN ? "enabled (Bearer token required)" : "DISABLED — set MCP_AUTH_TOKEN for production"}`);
});
