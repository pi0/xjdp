#!/usr/bin/env node
import { main } from "../dist/cli/index.mjs";

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
