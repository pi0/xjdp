import { defineBuildConfig } from "obuild/config";

export default defineBuildConfig({
  entries: [
    {
      type: "bundle",
      input: [
        "./src/index.ts",
        "./src/cli/index.ts",
        "./src/cli/web.ts",
        "./src/client/client.ts",
        "./src/server/handler.ts",
      ],
    },
  ],
});
