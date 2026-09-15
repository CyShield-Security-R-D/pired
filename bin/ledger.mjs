/**
 * The engagement ledger, for a process that never loaded pired.
 *
 * pi-subagents spawns children with extension bindings deliberately stripped
 * (`omitExtensionBindingsEnv`), so a child never loads pired and never sees
 * `record` or `recall`. Everything pired is for — the surface, the coverage
 * matrix, the hypotheses, the findings — is therefore invisible to exactly the
 * agents `ops-delegation` tells the operator to delegate to. A delegated recon
 * child cannot write down what it enumerated, and a delegated verifier cannot
 * write back its verdict; both have to marshal their results through prose in a
 * return value, which is the thing the ledger exists to stop.
 *
 * `pired-state` already proved the shape: an extension-less process that reaches
 * the engagement and uses pired's own derivation rather than scraping the
 * `.jsonl` files, chosen so the panel and the TUI can never disagree. That is
 * read-only. This is the other half — the same two tools, over the same
 * `Workspace`, through the same `core/tools.ts` code the extension calls. Not a
 * reimplementation: a child's `record` validates, allocates ids and appends
 * exactly as the parent's does, or the two would drift and the ledger would stop
 * being one account of the engagement.
 *
 * Decisions live here rather than in the entry script so they are covered.
 * ADR-006.
 */

/** Verbs the CLI dispatches. `record`/`recall` are the tools; `scope` and `pass` are local. */
export const LEDGER_VERBS = ["record", "recall", "scope", "pass"];

export const LEDGER_USAGE = `pired-ledger — read and write the engagement ledger from outside the TUI

For subagents and scripts: a child spawned without pired's extension has no
\`record\` or \`recall\` tool. This is those two tools, over the same workspace.

Usage:
  pired-ledger record <key=value>...
  pired-ledger recall <query> [key=value]...
  pired-ledger scope
  pired-ledger pass [next]

Examples:
  pired-ledger recall gaps
  pired-ledger recall challenge id=f3
  pired-ledger record kind=endpoint host=h1 method=GET path=/api/user file=api/user.go
  pired-ledger record kind=hypothesis statement="q reaches db.query unparameterized" \\
      target=e_search class=sqli outcome=testing
  pired-ledger record kind=finding title="SQLi in /search" severity=high target=e_search \\
      class=sqli cwe=CWE-89 evidence=core/search.js:42 evidence=core/db.js:9

Options:
  --engagement <name>  Which engagement   (default: the current directory's, else the newest)
  --json               Raw JSON rather than the rendered text
  --help               This text

\`pass\` reports which pass is open and what its lens reaches; \`pass next\` opens
the next one. The lens comes from the engagement's ladder, so a headless run
chooses it by setting the ladder — \`PIRED_PASSES=adversarial pired-ledger pass
next\` — rather than by naming one here.

Repeating a key builds a list (see \`evidence\` above). \`scope\` prints what the
engagement authorizes — it reports the boundary, it does not enforce one: a
child runs outside pired's gate, so the caller is still responsible for staying
inside what this prints.
`;

/**
 * Coerce one `key=value` token the way the tool's own readers need it.
 *
 * `core/tools.ts` reads numbers with `typeof v === "number"`, so a port arriving
 * as the string "80" is not rejected — it is silently dropped, and a service
 * lands in the ledger with no port at all. Booleans are the same story for
 * `delete=true`. Everything else stays a string, because that is what the
 * schema asks for and guessing further would turn a version like "1.0" into a
 * number that no longer matches what is installed.
 */
export function coerceValue(raw) {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+$/.test(raw)) {
    const n = Number(raw);
    if (Number.isSafeInteger(n)) return n;
  }
  return raw;
}

/**
 * `key=value` tokens to a tool args object.
 *
 * A repeated key builds a list, which is how `evidence` and `locations` are
 * given more than one entry without asking anyone to hand-write JSON in a shell.
 * A value may contain `=` — `evidence=a=b` is a value of `a=b` — because only
 * the first separator is structural.
 */
export function parseAssignments(tokens) {
  const args = {};
  for (const token of tokens) {
    const at = token.indexOf("=");
    if (at <= 0) throw new Error(`expected key=value, got "${token}"`);
    const key = token.slice(0, at);
    const value = coerceValue(token.slice(at + 1));
    if (!(key in args)) {
      args[key] = value;
      continue;
    }
    // Second sighting: promote to a list and keep both.
    if (Array.isArray(args[key])) args[key].push(value);
    else args[key] = [args[key], value];
  }
  return args;
}

/**
 * argv to a plan: which verb, what to hand the tool, and the CLI's own flags.
 *
 * `recall`'s query is positional (`recall gaps`) because that is how the skills
 * and the prompt already write it, and a child copying a line out of a skill
 * should not have to translate it into `query=gaps`.
 */
export function parseLedgerArgv(argv) {
  const plan = { verb: "", args: {}, engagement: undefined, json: false, help: false };
  const rest = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--help" || token === "-h") {
      plan.help = true;
    } else if (token === "--json") {
      plan.json = true;
    } else if (token === "--engagement") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error("--engagement needs a name");
      plan.engagement = value;
    } else {
      rest.push(token);
    }
  }

  if (plan.help || rest.length === 0) {
    plan.help = true;
    return plan;
  }

  const verb = rest[0];
  if (!LEDGER_VERBS.includes(verb)) {
    throw new Error(`unknown verb "${verb}" — expected ${LEDGER_VERBS.join(", ")}`);
  }
  plan.verb = verb;

  const tail = rest.slice(1);
  if (verb === "pass") {
    plan.args = { arg: tail[0] ?? "" };
    return plan;
  }
  if (verb === "recall") {
    // A bare `recall` is the status view, the same as the tool's default.
    const first = tail[0];
    if (first !== undefined && !first.includes("=")) {
      plan.args.query = first;
      plan.args = { ...plan.args, ...parseAssignments(tail.slice(1)) };
    } else {
      plan.args = parseAssignments(tail);
      if (plan.args.query === undefined) plan.args.query = "status";
    }
  } else {
    plan.args = parseAssignments(tail);
  }

  return plan;
}

/**
 * What `pired-ledger pass [arg]` is being asked to do.
 *
 * Only `next` opens one. A named lens is deliberately not accepted here, and the
 * reason is that a CLI invocation has no session to hold it in: the TUI's
 * `/pass <lens>` promotes the lens within the run that typed it, and the only
 * places a headless equivalent could persist that are the operator's
 * `scope.json` — which a child has no business rewriting — or a second copy of
 * the lens in the manifest, which would make the ladder and the manifest two
 * answers to the same question.
 *
 * Nothing is lost. The ladder is what decides the lens, and `PIRED_PASSES` sets
 * the ladder for exactly this kind of run, so `PIRED_PASSES=adversarial
 * pired-ledger pass next` reaches any lens without a second source of truth.
 */
export function planPassVerb(arg) {
  const want = String(arg ?? "").trim().toLowerCase();
  if (want === "" || want === "status") return { open: false };
  if (want === "next") return { open: true };
  throw new Error(
    `pass takes nothing or "next", got "${want}". The lens comes from the engagement's ladder — ` +
    `set it for this run with PIRED_PASSES=${want} and then \`pass next\`.`,
  );
}

/**
 * What the engagement authorizes, as lines a child can read or grep.
 *
 * Deliberately a report and not a gate. The gate is `createScopeGate`, it lives
 * in the parent's tool pipeline, and a child that never loaded the extension is
 * outside it — there is no honest way to make a CLI enforce a boundary on a
 * process that is free not to call it. Saying so is worth more than implying
 * otherwise, so the caller is told which of the two this is.
 */
export function renderScope(scope) {
  if (!scope) {
    return "No scope file found. Offensive and network actions are unauthorized;\nread-only local work is still fine.";
  }
  const lines = [];
  const mode = scope.strictUnresolved ? `${scope.mode}/strict` : scope.mode;
  lines.push(`engagement  ${scope.engagement}`);
  lines.push(`mode        ${mode}`);
  lines.push(`authorized  ${scope.authorized === true ? "yes" : "NO"}`);
  const t = scope.targets ?? {};
  for (const key of ["domains", "ips", "cidrs", "urls"]) {
    if (t[key]?.length) lines.push(`${key.padEnd(11)} ${t[key].join(", ")}`);
  }
  if (!t.domains?.length && !t.ips?.length && !t.cidrs?.length && !t.urls?.length) {
    lines.push("targets     none named");
  }
  const ex = scope.exclude ?? {};
  for (const key of ["domains", "ips", "cidrs", "urls"]) {
    if (ex[key]?.length) lines.push(`!${key.padEnd(10)} ${ex[key].join(", ")}`);
  }
  lines.push("");
  lines.push("This reports the boundary; it does not enforce it. A subagent runs outside");
  lines.push("pired's scope gate, so staying inside this is the caller's responsibility.");
  return lines.join("\n");
}

/** Pull the printable text out of a `ToolResult`, whatever content it carried. */
export function resultText(result) {
  const content = result?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c && c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
}
