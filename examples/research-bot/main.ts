import { ResearchManager } from './manager';

async function main() {
  const readline = await import('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  rl.question('What would you like to research? ', async (query: string) => {
    rl.close();
    const manager = new ResearchManager();
    await manager.run(query);
  });
}

if (require.main === module) {
  main();
}
