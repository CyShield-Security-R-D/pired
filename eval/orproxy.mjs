#!/usr/bin/env node
/**
 * OpenRouter proxy for eval runs: pins the serving host, meters spend, and stops
 * before the budget is gone.
 *
 * pi's provider config exposes `headers` but not request-body fields, and
 * OpenRouter's provider routing is a body field — so pinning a host from inside
 * pired is not possible. This sits in front instead: pired talks to it as an
 * OpenAI-compatible endpoint, and it injects the routing before forwarding.
 *
 * Two things come free with that position, and both matter for a metered run:
 *
 * - **Cost is measured, not estimated.** `usage.include` makes OpenRouter report
 *   the actual charge per request; the proxy accumulates it into a JSONL ledger.
 * - **The budget is enforced, not hoped for.** Past the cap it refuses rather
 *   than letting a long run drain the balance — and it refuses with a clear
 *   error, because this project has a history of failed runs being written down
 *   as measured zeros.
 *
 *   node eval/orproxy.mjs --port 8787 --budget 2.50 --providers Parasail
 *   node eval/orproxy.mjs --report          # print the ledger summary and exit
 */

import { createServer } from "node:http";
import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const arg = (n, d) => {
	const i = process.argv.indexOf(`--${n}`);
	const v = process.argv[i + 1];
	return i >= 0 && v && !v.startsWith("--") ? v : d;
};
const has = (n) => process.argv.includes(`--${n}`);

const LEDGER = arg("ledger", join(homedir(), ".pired", "orproxy-ledger.jsonl"));

function summary() {
	if (!existsSync(LEDGER)) return { n: 0, cost: 0, byProvider: {}, tokens: 0 };
	const rows = readFileSync(LEDGER, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
	const byProvider = {};
	let cost = 0;
	let tokens = 0;
	for (const r of rows) {
		cost += r.cost ?? 0;
		tokens += r.tokens ?? 0;
		const p = r.provider ?? "unknown";
		byProvider[p] = (byProvider[p] ?? 0) + (r.cost ?? 0);
	}
	return { n: rows.length, cost, tokens, byProvider };
}

if (has("report")) {
	const s = summary();
	process.stdout.write(`⦿ orproxy · ${s.n} requests · $${s.cost.toFixed(4)} · ${s.tokens.toLocaleString()} tokens\n`);
	for (const [p, c] of Object.entries(s.byProvider).sort((a, b) => b[1] - a[1])) {
		process.stdout.write(`  ${p.padEnd(16)} $${c.toFixed(4)}\n`);
	}
	process.exit(0);
}

const PORT = Number(arg("port", "8787"));
const BUDGET = Number(arg("budget", "2.50"));
const PROVIDERS = arg("providers", "Parasail").split(",").map((s) => s.trim()).filter(Boolean);
// A pinned host that goes down should fail loudly. A silent fallback to another
// host changes quantization mid-run, which is a confound that looks like a
// result — the exact thing this run exists to avoid.
const ALLOW_FALLBACK = has("allow-fallback");

const KEY =
	process.env.OPENROUTER_API_KEY ??
	(() => {
		const p = join(homedir(), ".pired", "models.json");
		const cfg = JSON.parse(readFileSync(p, "utf8"));
		const or = cfg.providers.find((x) => x.id === "openrouter");
		if (!or?.apiKey) throw new Error("no OpenRouter key in ~/.pired/models.json");
		return or.apiKey;
	})();

// Spend already on the ledger counts against the budget, so restarting the proxy
// mid-experiment does not silently reset the cap.
let spent = summary().cost;
let requests = 0;

const server = createServer((req, res) => {
	if (req.method === "GET" && req.url === "/status") {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ spent, budget: BUDGET, remaining: BUDGET - spent, requests, providers: PROVIDERS }));
		return;
	}

	const chunks = [];
	req.on("data", (c) => chunks.push(c));
	req.on("end", async () => {
		if (spent >= BUDGET) {
			res.writeHead(402, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: `orproxy: budget exhausted ($${spent.toFixed(4)} of $${BUDGET}). Run stopped deliberately — this is not a model result.`, code: 402 } }));
			process.stderr.write(`orproxy: BUDGET EXHAUSTED at $${spent.toFixed(4)} — refusing further requests\n`);
			return;
		}

		let body;
		try {
			body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		} catch {
			res.writeHead(400).end('{"error":{"message":"orproxy: bad JSON"}}');
			return;
		}

		body.provider = { order: PROVIDERS, allow_fallbacks: ALLOW_FALLBACK };
		// Ask for the real charge back. Without this the ledger would be an
		// estimate, which is the thing being replaced.
		body.usage = { include: true };

		// An upstream that accepts the connection and then goes quiet will hang the
		// agent behind it indefinitely — observed as a wedged scan burning wall
		// clock at 0% CPU with no requests for eight minutes. A timeout converts
		// that into an error the runner can see and report as a failure.
		const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
			method: "POST",
			signal: AbortSignal.timeout(Number(arg("upstream-timeout", "900")) * 1000),
			headers: {
				authorization: `Bearer ${KEY}`,
				"content-type": "application/json",
				"http-referer": "https://github.com/CyShield-Security-R-D/pired",
				"x-title": "pired-eval",
			},
			body: JSON.stringify(body),
		}).catch((e) => {
			res.writeHead(502, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: `orproxy: upstream unreachable — ${e.message}` } }));
			return undefined;
		});
		if (!upstream) return;

		requests += 1;
		res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });

		// Stream through untouched while sniffing the usage record, so metering
		// never changes what the agent receives.
		const record = (usage, provider, model) => {
			const cost = usage?.cost ?? 0;
			spent += cost;
			appendFileSync(
				LEDGER,
				`${JSON.stringify({
					ts: new Date().toISOString(), model, provider, cost,
					tokens: usage?.total_tokens ?? 0,
					prompt: usage?.prompt_tokens ?? 0, completion: usage?.completion_tokens ?? 0,
				})}\n`,
			);
			process.stderr.write(`orproxy: ${provider ?? "?"} $${cost.toFixed(5)} · run total $${spent.toFixed(4)} / $${BUDGET}\n`);
		};

		if (!upstream.body) {
			res.end();
			return;
		}
		const reader = upstream.body.getReader();
		const dec = new TextDecoder();
		let tail = "";
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				res.write(value);
				tail = (tail + dec.decode(value, { stream: true })).slice(-16384);
			}
		} catch (e) {
			// AbortSignal.timeout aborts the whole fetch, body included, so a long
			// stream trips it mid-read. Unhandled, that rejection is an uncaught
			// exception that kills the proxy and every agent behind it — which is
			// how a guard against hangs became a worse outage than the hang.
			process.stderr.write(`orproxy: stream ended early (${e?.name ?? e}) — partial response forwarded\n`);
		}
		res.end();

		// Non-streaming replies are one JSON object; streaming ends with a data:
		// frame carrying usage. Try both, cheapest first.
		try {
			const direct = JSON.parse(tail);
			if (direct?.usage) record(direct.usage, direct.provider, direct.model);
		} catch {
			for (const line of tail.split("\n").reverse()) {
				const t = line.trim();
				if (!t.startsWith("data:")) continue;
				const payload = t.slice(5).trim();
				if (payload === "[DONE]") continue;
				try {
					const obj = JSON.parse(payload);
					if (obj?.usage) {
						record(obj.usage, obj.provider, obj.model);
						break;
					}
				} catch {}
			}
		}
	});
});

// Last line of defence: a metering proxy that dies takes the whole run with it,
// so no single request may ever be fatal.
process.on("unhandledRejection", (e) => {
	process.stderr.write(`orproxy: unhandled rejection (${e?.name ?? e}) — continuing\n`);
});
process.on("uncaughtException", (e) => {
	process.stderr.write(`orproxy: uncaught (${e?.name ?? e}) — continuing\n`);
});

server.listen(PORT, "127.0.0.1", () => {
	process.stderr.write(
		`⦿ orproxy on http://127.0.0.1:${PORT}/v1 · pinned ${PROVIDERS.join(",")}${ALLOW_FALLBACK ? " (+fallback)" : ""} · budget $${BUDGET} (already spent $${spent.toFixed(4)})\n`,
	);
});
