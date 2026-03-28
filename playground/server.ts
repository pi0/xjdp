import { useStorage } from "nitro/storage";
import { createServer, parseKey, generateKeyPair, fingerprint } from "xjdp";

const serverKeyPair = await loadKeyPair("XJDP_SERVER_KEY");
const serverFp = await fingerprint(serverKeyPair.publicKey);

// Demo client key with full access
const demoClientKeyPair = await loadKeyPair("XJDP_DEMO_KEY");
const demoClientFp = await fingerprint(demoClientKeyPair.publicKey);

const kv = useStorage("sessions");
const rjdp = createServer({
  serverKeyPair,
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

// --- Exports ---

export default {
  fetch(req: Request): Response | Promise<Response> | void {
    const { pathname, searchParams } = new URL(req.url);
    // console.log(`${req.method} ${pathname}`);
    if (pathname.includes("/.jdp")) {
      return rjdp.fetch(req);
    }
    if (pathname.includes("/_info")) {
      const origin = new URL("/", req.url).href;
      const fp4 = serverFp.slice(0, 4);
      const key = searchParams.get("key");
      const info: Record<string, string> = {
        serverFingerprint: serverFp,
        cmdReadonly: `npx xjdp -u ${origin} -f ${fp4}`,
      };
      if (key) {
        info.cmdFull = `npx xjdp -u ${origin} -f ${fp4} -k ${key}`;
      }
      return Response.json(info);
    }
    if (pathname !== "/") {
      return new Response("Not found", { status: 404 });
    }
  },
};
