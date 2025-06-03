import { describe, test, expect } from 'vitest';
import { MCPServerStdio } from '../../../src/shims/mcp-stdio/browser';

describe('MCPServerStdio', () => {
  test('should be available', async () => {
    const server = new MCPServerStdio({
      name: 'test',
      fullCommand: 'test',
      cacheToolsList: true,
    });
    expect(server).toBeDefined();
    await expect(() => server.connect()).toThrow();
  });
});
