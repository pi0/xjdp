import { defineConfig } from "nitro";

export default defineConfig({
  storage: {
    sessions:
      process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
        ? {
            driver: "upstash",
            url: process.env.UPSTASH_REDIS_REST_URL,
            token: process.env.UPSTASH_REDIS_REST_TOKEN,
          }
        : { driver: "memory" },
  },
});
