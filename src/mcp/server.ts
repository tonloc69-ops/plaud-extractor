#!/usr/bin/env node
import path from 'node:path'
import os from 'node:os'
import pino from 'pino'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { defaultOutDir, runLogsPath } from '../storage/paths.js'
import { setLogger } from '../logger.js'
import { registerReadTools } from './read-tools.js'
import { registerJobTools } from './job-tools.js'
import { registerUploadTools } from './upload-tools.js'

const rawDir = process.env['ALTA_DATA_DIR']
const outDir = rawDir
  ? path.resolve(rawDir.replace(/^~/, os.homedir()))
  : defaultOutDir()

// MCP communicates over stdio — logs must go to file only, never stdout
const logger = pino(
  { level: 'debug' },
  pino.transport({
    targets: [{
      target: 'pino/file',
      options: { destination: runLogsPath(outDir), mkdir: true },
      level: 'debug',
    }],
  }),
)
setLogger(logger)

const server = new McpServer({
  name: 'alta-plaud',
  version: '1.0.0',
})

registerReadTools(server, outDir)
registerJobTools(server, outDir)
registerUploadTools(server, outDir)

const transport = new StdioServerTransport()
await server.connect(transport)
