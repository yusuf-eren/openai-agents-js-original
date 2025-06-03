import {
  BaseMCPServerStdio,
  CallToolResultContent,
  MCPServerStdioOptions,
  MCPTool,
} from '../../mcp';

export class MCPServerStdio extends BaseMCPServerStdio {
  constructor(params: MCPServerStdioOptions) {
    super(params);
  }
  get name(): string {
    return 'MCPServerStdio';
  }
  connect(): Promise<void> {
    throw new Error('Method not implemented.');
  }
  close(): Promise<void> {
    throw new Error('Method not implemented.');
  }
  listTools(): Promise<MCPTool[]> {
    throw new Error('Method not implemented.');
  }
  callTool(
    _toolName: string,
    _args: Record<string, unknown> | null,
  ): Promise<CallToolResultContent> {
    throw new Error('Method not implemented.');
  }
}
