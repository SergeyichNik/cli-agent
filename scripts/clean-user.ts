import { rmSync, existsSync } from 'node:fs';
import path from 'node:path';

// Usage: npm run clean:user -- <name>
const userName = process.argv[2];

if (!userName) {
  console.error('Error: specify user name');
  console.error('  npm run clean:user -- alice');
  process.exit(1);
}

const userDir = path.join(process.cwd(), 'data', 'users', userName);

if (!existsSync(userDir)) {
  console.error(`User data not found: ${userDir}`);
  process.exit(1);
}

rmSync(userDir, { recursive: true, force: true });
console.log(`Removed ${userDir}`);
