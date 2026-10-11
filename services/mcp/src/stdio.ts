#!/usr/bin/env node
// MCP over stdio. stdout is the protocol channel; everything else goes to stderr.
//   OPENING_CROSS_API   base URL of the Opening Cross API (default http://localhost:8080)
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { SERVER_NAME, createServer, httpApi } from './server.js';

const base = process.env.OPENING_CROSS_API ?? 'http://localhost:8080';
const stdio = serveStdio(() => createServer(httpApi(base)));
process.stderr.write(`${JSON.stringify({ level: 'info', msg: `${SERVER_NAME} mcp on stdio`, api: base })}\n`);

const shutdown = async () => {
  await stdio.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
process.stdin.on('end', () => void shutdown());
