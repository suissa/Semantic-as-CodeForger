import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export class ForgerMcpClient {
  private client?: Client;
  private connecting?: Promise<Client>;

  private async getClient(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      const client = new Client({ name: 'semantic-forger-backend', version: '0.1.0' });
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ['--import', 'tsx', 'src/mcp/server.ts'],
        cwd: process.cwd(),
        env: { ...process.env, FORGER_WORKSPACE_ROOT: process.env.FORGER_WORKSPACE_ROOT ?? '.forger-workspaces' } as Record<string, string>
      });
      await client.connect(transport);
      this.client = client;
      return client;
    })();

    try { return await this.connecting; }
    finally { this.connecting = undefined; }
  }

  async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const client = await this.getClient();
    const result = await client.callTool({ name, arguments: args });
    const first = result.content[0];
    if (!first || first.type !== 'text') throw new Error(`MCP tool ${name} returned no text payload`);
    return JSON.parse(first.text) as T;
  }

  async close(): Promise<void> {
    if (this.client) await this.client.close();
    this.client = undefined;
  }
}
