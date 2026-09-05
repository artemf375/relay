import { createConsistentSnapshot, integrityCheck } from "./operations.js";

const [command, source, destination] = process.argv.slice(2);

if (command === "integrity" && source) {
  const result = integrityCheck(source);
  console.log(JSON.stringify({ ok: result === "ok", result }));
  process.exitCode = result === "ok" ? 0 : 1;
} else if (command === "snapshot" && source && destination) {
  await createConsistentSnapshot(source, destination);
  console.log(JSON.stringify({ ok: true, destination }));
} else {
  console.error("Usage: node dist/ops.js integrity <database> | snapshot <database> <destination>");
  process.exitCode = 1;
}
