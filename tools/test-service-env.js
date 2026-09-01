// The parser that reads the service's settings out of reg.exe's output.
//
//   node tools/test-service-env.js
//
// The registry read itself needs the real service, so what is checked here is
// the parsing - which is the part that broke the .bat wrappers.
const path = require("path");
const { parse } = require(path.resolve(__dirname, "..", "backend", "serviceEnv.js"));

let failures = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}${ok ? "" : `\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`}`);
}

// Exactly what reg.exe prints for a REG_MULTI_SZ.
const real = [
  "",
  "HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\OMService\\Parameters",
  "    AppEnvironmentExtra    REG_MULTI_SZ    AUTOCOUNT_DB_SERVER=OMAPPSVR1\\A2006\\0AUTOCOUNT_DB_NAME=AED_OUTBOARD\\0AUTOCOUNT_DB_USER=omapp\\0AUTOCOUNT_DB_PASSWORD=s3cr3t\\0DRIVE_ENABLED=true",
  "",
].join("\r\n");

const env = parse(real, "AppEnvironmentExtra");
check("reads every setting", Object.keys(env).length, 5);
check("keeps a backslash in the value", env.AUTOCOUNT_DB_SERVER, "OMAPPSVR1\\A2006");
check("reads the database name", env.AUTOCOUNT_DB_NAME, "AED_OUTBOARD");
check("reads the one added later", env.DRIVE_ENABLED, "true");

// A password may contain "=" - only the first one separates name from value.
const eq = parse(
  '    AppEnvironmentExtra    REG_MULTI_SZ    AUTOCOUNT_DB_PASSWORD=a=b=c\\0X=1',
  "AppEnvironmentExtra"
);
check("a value containing = survives", eq.AUTOCOUNT_DB_PASSWORD, "a=b=c");
check("and the next setting is still read", eq.X, "1");

// A single setting, no separators at all.
check("a lone setting", parse("    AppEnvironment    REG_MULTI_SZ    ONLY=one", "AppEnvironment"), { ONLY: "one" });

// The value is simply not set: reg.exe prints an error, not a table.
check("missing value yields nothing", parse("ERROR: The system was unable to find the specified registry key or value.", "AppEnvironmentExtra"), {});
check("empty output yields nothing", parse("", "AppEnvironmentExtra"), {});

// A path value with a trailing backslash, which is easy to mangle.
const p = parse('    AppEnvironmentExtra    REG_MULTI_SZ    DRIVE_KEY_FILE=C:\\om-order-app\\backend\\drive-key.json', "AppEnvironmentExtra");
check("a Windows path survives intact", p.DRIVE_KEY_FILE, "C:\\om-order-app\\backend\\drive-key.json");

console.log(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
process.exit(failures ? 1 : 0);
