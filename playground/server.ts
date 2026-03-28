import { useStorage } from "nitro/storage";
import { createServer, parseKey, generateKeyPair, serializeKey, fingerprint } from "xjdp";

const serverKeyPair = await loadKeyPair("XJDP_SERVER_KEY");
const serverFp = await fingerprint(serverKeyPair.publicKey);

// Demo client key with full access
const { keyPair: demoClientKeyPair, serialized: demoClientKey } =
  await loadKeyPairWithSerialized("XJDP_DEMO_KEY");
const demoClientFp = await fingerprint(demoClientKeyPair.publicKey);

const kv = useStorage("sessions");
const rjdp = createServer({
  serverKeyPair,
  transports: ["http"],
  storage: {
    async get(key) {
      return ((await kv.getItem(key)) as string) ?? undefined;
    },
    async set(key, value, ttl) {
      // console.log(`Setting session ${key} with TTL ${ttl} ms`, value);
      await kv.setItem(key, value, ttl ? { ttl: Math.ceil(ttl / 1000) } : undefined);
    },
    async delete(key) {
      await kv.removeItem(key);
    },
  },
  acl: {
    "*": ["fs:read"],
    [demoClientFp]: ["eval", "exec", "fs:read", "fs:write"],
  },
});

function printInstructions(host: string): void {
  const fp4 = serverFp.slice(0, 4);
  const D = "\x1B[2m";
  const B = "\x1B[1m";
  const C = "\x1B[36m";
  const G = "\x1B[32m";
  const R = "\x1B[0m";
  const lines = [
    "",
    `${B}${G}XJDP Playground${R}  ${D}${host}${R}`,
    "",
    `  ${D}# Read-only:${R}`,
    `  ${C}npx xjdp -u http://${host} -f ${fp4}${R}`,
    "",
    `  ${D}# Full access (demo key):${R}`,
    `  ${C}npx xjdp -u http://${host} -f ${fp4} -k ${demoClientKey}${R}`,
    "",
  ];
  process.stdout.write(lines.join("\n") + "\n");
}

// --- Key loading helpers ---

async function loadKeyPair(envVar: string): Promise<CryptoKeyPair> {
  const raw = process.env[envVar];
  if (raw) {
    const result = await parseKey(raw);
    if ("privateKey" in result) return result;
    throw new Error(`${envVar} must be a private key`);
  }
  return generateKeyPair({ extractable: true });
}

async function loadKeyPairWithSerialized(
  envVar: string,
): Promise<{ keyPair: CryptoKeyPair; serialized: string }> {
  const raw = process.env[envVar];
  if (raw) {
    const result = await parseKey(raw);
    if (!("privateKey" in result)) throw new Error(`${envVar} must be a private key`);
    return { keyPair: result, serialized: raw };
  }
  const keyPair = await generateKeyPair({ extractable: true });
  const serialized = await serializeKey(keyPair.privateKey);
  return { keyPair, serialized };
}

// --- Exports ---

export default {
  printInstructions,
  fetch(req: Request): Response | Promise<Response> | void {
    const { pathname } = new URL(req.url);
    // console.log(`${req.method} ${pathname}`);
    if (pathname.includes("/.jdp")) {
      return rjdp.fetch(req);
    }
    if (pathname.includes("/_info")) {
      const origin = new URL("/", req.url).href;
      const fp4 = serverFp.slice(0, 4);
      return Response.json({
        serverFingerprint: serverFp,
        demoClientFingerprint: demoClientFp,
        demoClientKey,
        cmdReadonly: `npx xjdp -u ${origin} -f ${fp4}`,
        cmdFull: `npx xjdp -u ${origin} -f ${fp4} -k ${demoClientKey}`,
      });
    }
    if (pathname !== "/") {
      return new Response("Not found", { status: 404 });
    }
  },
};
