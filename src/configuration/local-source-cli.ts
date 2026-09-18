#!/usr/bin/env node
import { packLocalWorkflow } from "../delivery/local-workflow-pack.js";

const [command, directory, index, ...extra] = process.argv.slice(2);
if (command !== "pack" || !directory || !index || extra.length) {
  console.error("Usage: workflow-local-source pack <compiled-package-directory> <local-source.json>");
  process.exitCode = 1;
} else {
  try { console.log(JSON.stringify(await packLocalWorkflow(directory, index), null, 2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
