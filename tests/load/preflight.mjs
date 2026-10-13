#!/usr/bin/env node
/**
 * Runs before k6 in the `npm run load-test*` scripts.
 *
 * Without it a bare `npm run load-test` still fails safe — target.js throws in
 * k6's init stage — but the operator gets a stack trace, not an instruction.
 * This prints what to set and why production is refused, and exits 1 so
 * `&& k6 run …` never starts.
 *
 * k6 passes the system environment through as __ENV, so the TARGET_URL checked
 * here is the one the script will see (target.js checks it again there). This
 * file sends nothing over the network.
 */
import { preflight } from './target.js';

const result = preflight(process.env);
if (result.ok) {
  console.log(result.message);
} else {
  console.error(result.message);
  process.exit(1);
}
