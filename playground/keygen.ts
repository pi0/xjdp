// Generate .env with persistent server and demo client keys

import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { generateKeyPair, serializeKey, fingerprint } from "xjdp";

const envPath = resolve(import.meta.dirname!, ".env");

if (existsSync(envPath)) {
  process.exit(0);
}

const serverKp = await generateKeyPair({ extractable: true });
const demoKp = await generateKeyPair({ extractable: true });

const serverKey = await serializeKey(serverKp.privateKey);
const demoKey = await serializeKey(demoKp.privateKey);
const serverFp = await fingerprint(serverKp.publicKey);
const demoFp = await fingerprint(demoKp.publicKey);

const env = [
  "# XJDP Playground — generated keys",
  `# Server fingerprint: ${serverFp}`,
  `XJDP_SERVER_KEY=${serverKey}`,
  "",
  `# Demo client fingerprint: ${demoFp}`,
  `XJDP_DEMO_KEY=${demoKey}`,
  "",
].join("\n");

writeFileSync(envPath, env);
console.log(`Written ${envPath}`);
console.log(`  Server fingerprint: ${serverFp.slice(0, 8)}...`);
console.log(`  Demo client fingerprint: ${demoFp.slice(0, 8)}...`);
