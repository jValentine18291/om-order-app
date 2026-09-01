// serviceEnv.js
// ============================================================================
// Borrows the OMService service's own settings for one command.
//
// The AutoCount credentials live in the Windows service configuration, not in
// anybody's command prompt, so a diagnostic run by hand starts with none of
// them. The .bat wrappers tried to read them by piping NSSM's output through a
// `for /f` loop, which depends on NSSM's wide-text output, PowerShell quoting
// and cmd's parser all lining up - and when any of that shifts, the wrapper
// reports "could not read the settings" and there is nothing to debug.
//
// This reads the same values straight from where the service keeps them, with
// one command and one parser.
//
// Values are never printed. The names are, so a run can be checked without
// exposing a password - which matters here, because one of these is the
// AutoCount login.
// ============================================================================

const { execFileSync } = require("child_process");

const SERVICE = process.env.OM_SERVICE_NAME || "OMService";
const KEY = `HKLM\\SYSTEM\\CurrentControlSet\\Services\\${SERVICE}\\Parameters`;

// NSSM stores the environment under AppEnvironmentExtra (added to the system
// environment) or AppEnvironment (replacing it), depending on how it was set.
// Both are read; whichever exists wins, and Extra is read last so it takes
// precedence, matching how the service itself resolves them.
const VALUES = ["AppEnvironment", "AppEnvironmentExtra"];

// reg.exe prints a REG_MULTI_SZ on one line with a literal \0 between entries:
//   AppEnvironmentExtra    REG_MULTI_SZ    A=1\0B=2
function parse(out, valueName) {
  const line = out.split(/\r?\n/).find((l) => l.includes(valueName) && l.includes("REG_"));
  if (!line) return {};
  const after = line.split(/REG_\w+\s+/)[1];
  if (!after) return {};
  const env = {};
  for (const pair of after.split("\\0")) {
    const at = pair.indexOf("=");
    // A name with no "=" is not a setting; a value containing "=" is fine,
    // because only the FIRST one separates name from value.
    if (at > 0) env[pair.slice(0, at).trim()] = pair.slice(at + 1);
  }
  return env;
}

function read() {
  const env = {};
  for (const valueName of VALUES) {
    let out = "";
    try {
      out = execFileSync("reg", ["query", KEY, "/v", valueName], {
        encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      });
    } catch (_) {
      continue;                       // that value simply is not set
    }
    Object.assign(env, parse(out, valueName));
  }
  return env;
}

// Fill in anything not already set in this shell, so a value typed by hand
// still wins over the service's copy.
function load({ quiet = false } = {}) {
  let env = {};
  try {
    env = read();
  } catch (e) {
    if (!quiet) console.error(`Could not read the ${SERVICE} settings: ${e.message}`);
    return [];
  }
  const loaded = [];
  for (const [k, v] of Object.entries(env)) {
    if (process.env[k] === undefined) {
      process.env[k] = v;
      loaded.push(k);
    }
  }
  // Three different situations, said apart. "Nothing loaded" on its own is
  // what made the old wrapper impossible to debug: it could equally mean the
  // service was not found, or that everything was already set.
  if (!quiet) {
    const found = Object.keys(env).length;
    if (loaded.length) console.log(`Borrowed from the ${SERVICE} service: ${loaded.join(", ")}\n`);
    else if (found) console.log(`The ${SERVICE} settings are already set in this window.\n`);
    else console.log(
      `Found no settings for a service called "${SERVICE}".\n` +
      `  Run this ON THE SERVER, where OMService is installed.\n` +
      `  If the service has another name, set OM_SERVICE_NAME first.\n`
    );
  }
  return loaded;
}

module.exports = { load, read, parse, SERVICE, KEY };

// Run this file directly to see which settings the service holds, by NAME
// only. That is the check to make when a diagnostic says it cannot connect:
// it distinguishes "the service has no such setting" from "the value is wrong"
// without putting a password on screen.
if (require.main === module) {
  const env = read();
  const names = Object.keys(env).sort();
  if (!names.length) {
    console.log(`Found no settings for a service called "${SERVICE}".`);
    console.log(`  Looked in: ${KEY}`);
    console.log("  Run this on the server. If the service has another name, set OM_SERVICE_NAME.");
  } else {
    console.log(`${SERVICE} holds ${names.length} setting(s) — names only, no values:\n`);
    for (const n of names) console.log(`  ${n}`);
  }
}
