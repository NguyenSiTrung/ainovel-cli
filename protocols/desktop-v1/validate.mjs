#!/usr/bin/env node
/**
 * Deterministic validation for the desktop-v1 protocol.
 *
 * Rules enforced by this script:
 *   1. commands.schema.json and events.schema.json are valid JSON Schema
 *      draft 2020-12 documents and compile with ajv (strict mode).
 *   2. The catalogs are structurally complete: every method enum value has a
 *      named payload def and an if/then selector; same for every event.
 *   3. Every line of every fixture file ending in .jsonl is checked:
 *        - files named invalid-*.jsonl  -> every line must be REJECTED
 *          (unparseable JSON, or parseable but rejected by both schemas);
 *        - all other fixture files      -> every line must be ACCEPTED
 *          (parseable and valid against at least one schema; requests are
 *          validated by commands.schema.json, responses/events by
 *          events.schema.json).
 *   4. Blank lines are skipped (they are not protocol messages).
 *   5. Required-field probes: envelopes missing protocol / kind / id / method
 *      (requests), id / ok (responses), event / sequence (events), plus a
 *      wrong-protocol-version probe, must all be REJECTED.
 *   6. Envelope probes: the binding envelope examples must be ACCEPTED.
 *
 * The script exits non-zero on ANY unexpected result (an invalid fixture line
 * accepted, a valid fixture line rejected, a probe behaving unexpectedly, a
 * missing fixture file, or an unexpected extra .jsonl fixture file).
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020Module from "ajv/dist/2020.js";

const Ajv2020 = Ajv2020Module?.Ajv2020 ?? Ajv2020Module?.default ?? Ajv2020Module;
if (typeof Ajv2020 !== "function") {
  console.error("FAIL: could not load Ajv2020 from ajv/dist/2020");
  process.exit(1);
}

const ROOT = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(ROOT, "fixtures");

const EXPECTED_FIXTURES = [
  "invalid-malformed-line.jsonl",
  "invalid-schema-violations.jsonl",
  "valid-events-catalog.jsonl",
  "valid-events-duplicate-sequence-replay.jsonl",
  "valid-events-sidecar-recovery.jsonl",
  "valid-events-stream-lifecycle.jsonl",
  "valid-request.jsonl",
  "valid-requests-catalog.jsonl",
  "valid-response-error.jsonl",
  "valid-response-success.jsonl",
];

const METHOD_COUNT = 48;
const EVENT_COUNT = 26;
const ERROR_CODE_COUNT = 9;

let failures = 0;
const fail = (message) => {
  failures += 1;
  console.error(`FAIL: ${message}`);
};

// ---------- load and compile schemas ----------
const commandsSchema = JSON.parse(readFileSync(join(ROOT, "commands.schema.json"), "utf8"));
const eventsSchema = JSON.parse(readFileSync(join(ROOT, "events.schema.json"), "utf8"));

const ajv = new Ajv2020({ allErrors: true, strict: true });
let validateCommands;
let validateEvents;
try {
  validateCommands = ajv.compile(commandsSchema);
  validateEvents = ajv.compile(eventsSchema);
} catch (error) {
  console.error(`FAIL: schema compilation error: ${error.message}`);
  process.exit(1);
}

const summarizeErrors = (validate) =>
  (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`).join("; ");

// ---------- structural checks on the catalogs ----------
const methods = commandsSchema.properties.method.enum;
const events = eventsSchema.$defs.event_envelope.properties.event.enum;
const errorCodes = eventsSchema.$defs.error_code.enum;
const requestDefs = Object.keys(commandsSchema.$defs);
const eventDefs = Object.keys(eventsSchema.$defs);

if (methods.length !== METHOD_COUNT) fail(`method catalog has ${methods.length} entries, expected ${METHOD_COUNT}`);
if (events.length !== EVENT_COUNT) fail(`event catalog has ${events.length} entries, expected ${EVENT_COUNT}`);
if (errorCodes.length !== ERROR_CODE_COUNT) fail(`error code catalog has ${errorCodes.length} entries, expected ${ERROR_CODE_COUNT}`);

const missingRequestDefs = methods.filter((m) => !requestDefs.includes(`${m.replaceAll(".", "_")}_request`));
if (missingRequestDefs.length > 0) fail(`methods without a named payload def: ${missingRequestDefs.join(", ")}`);

const missingEventDefs = events.filter((e) => !eventDefs.includes(`${e.replaceAll(".", "_")}_event`));
if (missingEventDefs.length > 0) fail(`events without a named payload def: ${missingEventDefs.join(", ")}`);

const requestSelectors = (commandsSchema.allOf ?? []).map((a) => a?.then?.properties?.payload?.["$ref"]);
if (requestSelectors.length !== METHOD_COUNT) fail(`request if/then selector count is ${requestSelectors.length}, expected ${METHOD_COUNT}`);
const unresolvedRequestRefs = requestSelectors.filter((r) => typeof r !== "string" || !requestDefs.includes(r.slice("#/$defs/".length)));
if (unresolvedRequestRefs.length > 0) fail(`unresolved request payload refs: ${unresolvedRequestRefs.join(", ")}`);

const eventSelectors = (eventsSchema.$defs.event_envelope.allOf ?? []).map((a) => a?.then?.properties?.payload?.["$ref"]);
if (eventSelectors.length !== EVENT_COUNT) fail(`event if/then selector count is ${eventSelectors.length}, expected ${EVENT_COUNT}`);
const unresolvedEventRefs = eventSelectors.filter((r) => typeof r !== "string" || !eventDefs.includes(r.slice("#/$defs/".length)));
if (unresolvedEventRefs.length > 0) fail(`unresolved event payload refs: ${unresolvedEventRefs.join(", ")}`);

// ---------- fixture files ----------
const fixtureFiles = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".jsonl")).sort();
const missingFiles = EXPECTED_FIXTURES.filter((f) => !fixtureFiles.includes(f));
if (missingFiles.length > 0) fail(`missing expected fixture files: ${missingFiles.join(", ")}`);
const extraFiles = fixtureFiles.filter((f) => !EXPECTED_FIXTURES.includes(f));
if (extraFiles.length > 0) fail(`unexpected extra .jsonl fixture files: ${extraFiles.join(", ")}`);

let checkedLines = 0;
let acceptedLines = 0;
let rejectedLines = 0;

for (const file of fixtureFiles) {
  const expectValid = !file.startsWith("invalid-");
  const raw = readFileSync(join(FIXTURES_DIR, file), "utf8");
  const lines = raw.split("\n").map((l, i) => ({ text: l, number: i + 1 })).filter((l) => l.text.trim() !== "");
  if (lines.length === 0) fail(`${file}: contains no non-blank lines`);

  for (const line of lines) {
    checkedLines += 1;
    let value;
    let parsed = true;
    try {
      value = JSON.parse(line.text);
    } catch {
      parsed = false;
    }

    let accepted = false;
    let why = "";
    if (parsed) {
      const commandsOk = validateCommands(value);
      const eventsOk = validateEvents(value);
      accepted = commandsOk || eventsOk;
      if (!accepted) {
        why = `commands errors [${summarizeErrors(validateCommands)}]; events errors [${summarizeErrors(validateEvents)}]`;
      }
    } else {
      why = "line is not parseable JSON";
    }

    if (expectValid && !accepted) {
      fail(`${file} line ${line.number}: expected a valid protocol message but it was rejected (${why})`);
    }
    if (!expectValid && accepted) {
      fail(`${file} line ${line.number}: expected rejection but the line validates against a schema`);
    }
    if (accepted) acceptedLines += 1;
    else rejectedLines += 1;
  }
}

// ---------- required-field and version probes (must be rejected) ----------
const NEGATIVE_PROBES = [
  { label: "request without protocol", schema: "commands", value: { kind: "request", id: "probe-1", method: "engine.ping", payload: {} } },
  { label: "request without kind", schema: "commands", value: { protocol: "desktop-v1", id: "probe-1", method: "engine.ping", payload: {} } },
  { label: "request without id", schema: "commands", value: { protocol: "desktop-v1", kind: "request", method: "engine.ping", payload: {} } },
  { label: "request without method", schema: "commands", value: { protocol: "desktop-v1", kind: "request", id: "probe-1", payload: {} } },
  { label: "request with wrong protocol version", schema: "commands", value: { protocol: "desktop-v2", kind: "request", id: "probe-1", method: "engine.ping", payload: {} } },
  { label: "response without protocol", schema: "events", value: { kind: "response", id: "probe-1", ok: true, payload: {} } },
  { label: "response without kind", schema: "events", value: { protocol: "desktop-v1", id: "probe-1", ok: true, payload: {} } },
  { label: "response without id", schema: "events", value: { protocol: "desktop-v1", kind: "response", ok: true, payload: {} } },
  { label: "response without ok", schema: "events", value: { protocol: "desktop-v1", kind: "response", id: "probe-1", payload: {} } },
  { label: "event without protocol", schema: "events", value: { kind: "event", event: "engine.ready", sequence: 1, payload: {} } },
  { label: "event without kind", schema: "events", value: { protocol: "desktop-v1", event: "engine.ready", sequence: 1, payload: {} } },
  { label: "event without event", schema: "events", value: { protocol: "desktop-v1", kind: "event", sequence: 1, payload: {} } },
  { label: "event without sequence", schema: "events", value: { protocol: "desktop-v1", kind: "event", event: "engine.ready", payload: {} } },
];

for (const probe of NEGATIVE_PROBES) {
  const validate = probe.schema === "commands" ? validateCommands : validateEvents;
  const rejected = !validate(probe.value);
  if (!rejected) fail(`probe "${probe.label}" was accepted, expected rejection`);
}

// ---------- envelope probes (must be accepted) ----------
const POSITIVE_PROBES = [
  {
    label: "binding request envelope example",
    schema: "commands",
    value: { protocol: "desktop-v1", kind: "request", id: "req-8f3a", method: "engine.ping", payload: {} },
  },
  {
    label: "binding response envelope example",
    schema: "events",
    value: { protocol: "desktop-v1", kind: "response", id: "req-8f3a", ok: true, payload: {} },
  },
  {
    label: "binding event envelope example (catalog-corrected event name)",
    schema: "events",
    value: { protocol: "desktop-v1", kind: "event", event: "run.progress", project_id: "project-123", sequence: 481, payload: {} },
  },
];

for (const probe of POSITIVE_PROBES) {
  const validate = probe.schema === "commands" ? validateCommands : validateEvents;
  const accepted = validate(probe.value);
  if (!accepted) fail(`probe "${probe.label}" was rejected (${summarizeErrors(validate)}), expected acceptance`);
}

// ---------- summary ----------
const verdict = failures === 0 ? "OK" : "FAILED";
console.log("desktop-v1 protocol validation");
console.log(`  schemas: commands.schema.json (${methods.length} methods), events.schema.json (${events.length} events, ${errorCodes.length} error codes)`);
console.log(`  fixtures: ${fixtureFiles.length} files, ${checkedLines} non-blank lines (${acceptedLines} accepted, ${rejectedLines} rejected, all as expected)`);
console.log(`  negative probes: ${NEGATIVE_PROBES.length} rejected as required`);
console.log(`  envelope probes: ${POSITIVE_PROBES.length} accepted as required`);
console.log(`RESULT: ${verdict}`);

process.exit(failures === 0 ? 0 : 1);
