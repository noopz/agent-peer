#!/usr/bin/env node
import { runCli } from "../src/agent-peer.mjs";

await runCli(process.argv.slice(2));
