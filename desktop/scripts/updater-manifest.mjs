#!/usr/bin/env node
// Assemble the Tauri v2 updater manifest (latest.json) from a release
// directory containing the updater artifacts and their .sig files produced
// by `tauri build` (bundle.createUpdaterArtifacts: true).
//
// This script contains NO signing keys: signatures are read from the .sig
// files the bundler produced with TAURI_SIGNING_PRIVATE_KEY at build time.
//
// Usage:
//   node scripts/updater-manifest.mjs --dir <release-dir> --version <x.y.z> \
//        --base-url <artifact-download-base> [--notes <string>] [--out <file>]
//
// Artifact mapping (Tauri v2 updater keys):
//   *.app.tar.gz + .sig   -> darwin-aarch64 (aarch64 in name) / darwin-x86_64 (x64 in name)
//   *.nsis.zip|.msi.zip + .sig -> windows-x86_64
//   *.AppImage + .sig     -> linux-x86_64
//
// The updater endpoint (where latest.json is hosted) is a documented
// placeholder in release one; the app does not consume it yet. See
// desktop/README.md ("Updater (placeholder)").

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

function arg(name, required = true) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= argv.length) {
    if (required) {
      console.error(`updater-manifest: missing --${name}`);
      process.exit(2);
    }
    return undefined;
  }
  return argv[i + 1];
}

const dir = arg("dir");
const version = arg("version");
const baseUrl = arg("base-url").replace(/\/+$/, "");
const notes = arg("notes", false) ?? "";
const out = arg("out", false) ?? join(dir, "latest.json");

const files = readdirSync(dir);
const platforms = {};
const errors = [];

function signatureFor(file) {
  const sigPath = join(dir, `${file}.sig`);
  if (!existsSync(sigPath)) {
    errors.push(`missing signature: ${file}.sig`);
    return null;
  }
  return readFileSync(sigPath, "utf8").trim();
}

function addPlatform(key, file) {
  if (platforms[key]) return; // first wins (msi vs nsis order is arbitrary)
  const signature = signatureFor(file);
  if (signature === null) return;
  platforms[key] = { signature, url: `${baseUrl}/${encodeURIComponent(file)}` };
  console.log(`updater-manifest: ${key} <- ${file}`);
}

// Deterministic order so repeated runs produce identical output.
for (const file of files.slice().sort()) {
  const lower = file.toLowerCase();
  if (lower.endsWith(".app.tar.gz")) {
    addPlatform(lower.includes("aarch64") ? "darwin-aarch64" : "darwin-x86_64", file);
  } else if (lower.endsWith(".nsis.zip") || lower.endsWith(".msi.zip")) {
    addPlatform("windows-x86_64", file);
  } else if (lower.endsWith(".appimage")) {
    addPlatform("linux-x86_64", file);
  }
}

if (errors.length > 0) {
  for (const e of errors) console.error(`updater-manifest: ${e}`);
  process.exit(1);
}
if (Object.keys(platforms).length === 0) {
  console.error("updater-manifest: no updater artifacts found in " + dir);
  process.exit(1);
}

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms,
};
writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");
console.log(`updater-manifest: wrote ${out} for ${Object.keys(platforms).length} platform(s)`);
