#!/usr/bin/env node

import { resolve } from "node:path";
import { fileExists, isDirectory, isFile } from "@ares/files";
import {
  generateCurrentSchemasFileFromDatasourceFile,
  generateCurrentSchemasFilesFromRoot,
} from "./index.js";

function printUsage() {
  console.log(
    [
      "Usage:",
      "  ares-datasource-current-schemas <datasource.js|datasources-root> [--missing-only]",
      "",
      "Examples:",
      "  ares-datasource-current-schemas ./datasources/app/datasource.js",
      "  ares-datasource-current-schemas ./datasources --missing-only",
    ].join("\n")
  );
}

function getPathKind(targetPath) {
  if (isDirectory(targetPath)) return "directory";
  if (isFile(targetPath)) return "file";
  return null;
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  printUsage();
  process.exit(0);
}

const missingOnly = args.includes("--missing-only");
const targetArgument = args.find((argument) => !argument.startsWith("--")) ?? process.cwd();
const targetPath = resolve(targetArgument);
const targetKind = getPathKind(targetPath);

if (!targetKind) {
  console.error(`Target not found: ${targetPath}`);
  process.exit(1);
}

try {
  if (targetKind === "directory") {
    const results = await generateCurrentSchemasFilesFromRoot(targetPath, {
      force: !missingOnly,
    });
    results.forEach((result) => console.log(result.filePath));
  } else {
    const result = await generateCurrentSchemasFileFromDatasourceFile(targetPath, {
      force: !missingOnly,
    });
    console.log(result.filePath);
  }
} catch (error) {
  console.error(error?.stack ?? error?.message ?? String(error));
  process.exit(1);
}
