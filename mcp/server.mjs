import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import axios from 'axios';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.join(__dirname, '..');

const DEFAULT_BASE_URL =
  process.env.MCP_BASE_URL || process.env.BASE_URL || process.env.BASE_PROD || 'http://localhost:3000';
const DEFAULT_CLIENT_TOKEN = process.env.MCP_CLIENT_TOKEN || process.env.STUDENT_TOKEN || '1234567';
const DEFAULT_ADMIN_TOKEN = process.env.MCP_ADMIN_TOKEN || process.env.ADMIN_TOKEN || 'admin-secret-token';
const SERVER_NAME = process.env.MCP_SERVER_NAME || 'travel-planner-streamable';
const SERVER_VERSION = process.env.MCP_SERVER_VERSION || '1.0.0';

async function loadJson(relativePath) {
  const fullPath = path.join(ROOT_DIR, relativePath);
  const raw = await fs.readFile(fullPath, 'utf8');
  return JSON.parse(raw);
}

function toZod(schema) {
  if (!schema) return z.any();
  const type = schema.type;
  let base;
  switch (type) {
    case 'string':
      base = z.string();
      break;
    case 'integer':
    case 'number':
      base = z.number();
      break;
    case 'boolean':
      base = z.boolean();
      break;
    case 'array':
      base = z.array(toZod(schema.items));
      break;
    case 'object': {
      const shape = {};
      const req = new Set(schema.required || []);
      for (const [key, propSchema] of Object.entries(schema.properties || {})) {
        const zodProp = toZod(propSchema);
        shape[key] = req.has(key) ? zodProp : zodProp.optional();
      }
      base = z.object(shape);
      if (schema.additionalProperties) {
        base = base.catchall(toZod(schema.additionalProperties));
      } else {
        base = base.passthrough();
      }
      break;
    }
    default:
      base = z.any();
  }
  if (schema.enum && Array.isArray(schema.enum) && schema.enum.length > 0) {
    const literals = schema.enum.map((v) => z.literal(v));
    base = z.union(literals);
  }
  if (schema.description) {
    base = base.describe(schema.description);
  }
  return base;
}

function buildInputSchema(operation) {
  const shape = {
    authorization: z
      .string()
      .optional()
      .describe('Optional Authorization header override; defaults to the server token for this spec.'),
  };

  for (const param of operation.parameters || []) {
    const schema = param.schema || { type: 'string' };
    const field = toZod(schema);
    shape[param.name] = param.required ? field : field.optional();
  }

  if (operation.requestBody) {
    const bodySchema =
      operation.requestBody?.content?.['application/json']?.schema || { type: 'object' };
    const field = toZod(bodySchema);
    shape.body = operation.requestBody.required ? field : field.optional();
  }

  return z.object(shape).passthrough();
}

function formatResponsePayload(response) {
  if (!response) return 'No response received';
  const payload = {
    status: response.status,
    statusText: response.statusText,
    data: response.data,
  };
  return JSON.stringify(payload, null, 2);
}

function formatError(err) {
  if (err?.response) {
    return JSON.stringify(
      {
        status: err.response.status,
        statusText: err.response.statusText,
        data: err.response.data,
      },
      null,
      2
    );
  }
  return err?.message || 'Unknown error';
}

function sanitizeToolName(label, operationId) {
  const raw = `${label}-${operationId}`;
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, '-');
  return cleaned.slice(0, 64);
}

async function registerOpenApiSet(server, { label, specPath, defaultAuth, baseUrl }) {
  const definition = await loadJson(specPath);
  const resourceUri = `travel-planner-${label}://openapi`;
  server.registerResource(
    `openapi-${label}`,
    resourceUri,
    {
      title: `OpenAPI ${label} spec`,
      description: `Travel Planner ${label} OpenAPI definition served over MCP`,
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href || resourceUri,
          mimeType: 'application/json',
          text: JSON.stringify(definition, null, 2),
        },
      ],
    })
  );

  for (const [pathKey, methods] of Object.entries(definition.paths || {})) {
    for (const [method, operation] of Object.entries(methods || {})) {
      if (method === 'parameters') continue;
      if (typeof operation !== 'object' || !operation || Array.isArray(operation)) continue;
      if (method.startsWith('x-')) continue;
      const operationId = operation.operationId || `${method}_${pathKey}`.replace(/[^a-z0-9]+/gi, '_');
      const toolName = sanitizeToolName(label, operationId);
      const hasRequestBody = Boolean(operation.requestBody);

      server.registerTool(
        toolName,
        {
          name: toolName,
          title: `${label.toUpperCase()} ${operation.summary || operationId}`,
          description:
            operation.description ||
            `${method.toUpperCase()} ${pathKey} (default Authorization: ${label})`,
          inputSchema: buildInputSchema(operation),
        },
        async (args = {}) => {
          const { authorization, body, ...rest } = args;
          const headers = {};
          const token = authorization || defaultAuth;
          if (token) headers.Authorization = token;
          if (hasRequestBody) headers['Content-Type'] = 'application/json';

          // build path with params
          let urlPath = pathKey;
          const queryParams = new URLSearchParams();
          for (const param of operation.parameters || []) {
            const name = param.name;
            const val = rest[name];
            if (param.in === 'path') {
              if (val === undefined || val === null) {
                return {
                  isError: true,
                  content: [{ type: 'text', text: `Missing required path param: ${name}` }],
                };
              }
              urlPath = urlPath.replace(`{${name}}`, encodeURIComponent(String(val)));
            } else if (param.in === 'query' && val !== undefined) {
              queryParams.append(name, String(val));
            }
          }

          const url = new URL(urlPath, baseUrl);
          if ([...queryParams.keys()].length) url.search = queryParams.toString();

          const requestConfig = {
            method,
            url: url.toString(),
            headers,
            data: hasRequestBody ? body : undefined,
          };

          try {
            const response = await axios(requestConfig);
            return {
              content: [{ type: 'text', text: formatResponsePayload(response) }],
            };
          } catch (err) {
            return {
              isError: true,
              content: [{ type: 'text', text: formatError(err) }],
            };
          }
        }
      );
    }
  }
}

export async function createMcpServer() {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  await registerOpenApiSet(server, {
    label: 'client',
    specPath: 'src/openapi-client.json',
    defaultAuth: DEFAULT_CLIENT_TOKEN,
    baseUrl: DEFAULT_BASE_URL,
  });

  // NOTE: admin tools are intentionally disabled for now; enable later if needed.
  // await registerOpenApiSet(server, {
  //   label: 'admin',
  //   specPath: 'src/openapi-admin.json',
  //   defaultAuth: DEFAULT_ADMIN_TOKEN,
  //   baseUrl: DEFAULT_BASE_URL,
  // });

  return server;
}

export default createMcpServer;
