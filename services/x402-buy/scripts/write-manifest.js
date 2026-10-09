// Regenerate the static x402-resources.json manifest from the current config.
// This file is what gets submitted to x402scan.com; the live service also
// serves it at GET /x402-resources.json.
"use strict";

const fs = require("fs");
const path = require("path");
const { loadServiceConfig } = require("../src/config");
const { buildManifest } = require("../src/discovery");

const cfg = loadServiceConfig();
const manifest = buildManifest(cfg);
const out = path.join(__dirname, "..", "x402-resources.json");
fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");
// eslint-disable-next-line no-console
console.log(`wrote ${out}`);
