import { describe, test, expect } from 'vitest';
import { NodeMCPServerStdio } from '../../../src/shims/mcp-stdio/node';

describe('NodeMCPServerStdio', () => {
  test('should be available', async () => {
    const server = new NodeMCPServerStdio({
      name: 'test',
      fullCommand: 'test',
      cacheToolsList: true,
    });
    expect(server).toBeDefined();
    expect(server.name).toBe('test');
    expect(server.cacheToolsList).toBe(true);
    await expect(server.connect()).rejects.toThrow();
  });
});
