import cors from 'cors';
import express from 'express';
import dotenv from 'dotenv';
import NodeCache from 'node-cache';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { createMcpServer } from './server.mjs';

dotenv.config();

const app = express();
app.use(express.json({ limit: '1mb' }));

const parsedOrigins =
  !process.env.MCP_CORS_ORIGIN || process.env.MCP_CORS_ORIGIN === '*'
    ? '*'
    : process.env.MCP_CORS_ORIGIN.split(',').map((v) => v.trim()).filter(Boolean);

app.use(
  cors({
    origin: parsedOrigins,
    exposedHeaders: ['mcp-session-id'],
    allowedHeaders: ['Content-Type', 'mcp-session-id', 'mcp-protocol-version'],
  })
);

const transportCache = new NodeCache({
  stdTTL: 3600,
  checkperiod: 0,
  useClones: false,
});

const rawAllowedHosts = process.env.MCP_ALLOWED_HOSTS || '127.0.0.1,localhost,leiame.app';
const allowAnyHost = rawAllowedHosts.trim() === '*';
const allowedHosts = allowAnyHost
  ? undefined
  : rawAllowedHosts
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);

const mcpServer = await createMcpServer();
const MCP_PORT = Number(process.env.MCP_PORT || 3333);

function normalizeSessionId(rawId) {
  if (!rawId) return null;
  return Array.isArray(rawId) ? rawId[0] : rawId;
}

async function handleWithTransport(req, res, hasBody = false) {
  const sessionId = normalizeSessionId(req.headers['mcp-session-id']);
  let transport = sessionId ? transportCache.get(sessionId) : null;

  if (!transport && hasBody && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        transportCache.set(sid, transport);
        transport.onclose = () => transportCache.del(sid);
      },
      enableDnsRebindingProtection: !allowAnyHost,
      allowedHosts,
    });

    await mcpServer.connect(transport);
  } else if (!transport) {
    res.status(400).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Bad Request: No valid session ID provided',
      },
      id: null,
    });
    return;
  }

  try {
    if (hasBody && req.body && req.body.method === 'tools/call' && req.body.params) {
      const args = req.body.params.arguments || {};
      if (!args.authorization) {
        const headerAuth =
          req.headers['authorization']?.replace(/^Bearer\s+/i, '').trim() ||
          req.headers['x-mcp-proxy-auth']?.replace(/^Bearer\s+/i, '').trim();
        if (headerAuth) {
          req.body.params.arguments = { ...args, authorization: headerAuth };
        }
      }
    }
    await transport.handleRequest(req, res, hasBody ? req.body : undefined);
  } catch (err) {
    console.error('MCP transport error', err);
    res.status(500).json({ error: 'MCP transport error', message: err.message });
  }
}

app.post('/mcp', (req, res) => handleWithTransport(req, res, true));
app.get('/mcp', (req, res) => handleWithTransport(req, res, false));
app.delete('/mcp', (req, res) => handleWithTransport(req, res, false));

app.listen(MCP_PORT, () => {
  console.log(`Streamable HTTP MCP server listening on http://localhost:${MCP_PORT}/mcp`);
});
