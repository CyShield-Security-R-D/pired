import { describe, expect, it } from "vitest";
import { enclosingSpan, sameRoutine } from "./spans.ts";

const GO = `package runner

import "os/exec"

func (r *Runner) Run(raw string, path string) error {
	if strings.HasSuffix(raw, "&") {
		blocking = false
	}

	command, err := ParseCommand(r.Settings, raw)
	if err != nil {
		return err
	}

	envMapping := func(key string) string {
		switch key {
		case "FILE":
			return path
		}
		return ""
	}
	return nil
}

func Other() {
	return
}
`;

const PY = `import os

def safe(a):
    return a


def fetch(url):
    r = requests.get(url)
    return r.text


def last():
    pass
`;

const RB = `class Feed
  def show
    @entry = Entry.find(params[:id])
    render :show
  end

  def other
    nil
  end
end
`;

describe("the routine a line belongs to", () => {
	it("brackets a Go function around the whole body", () => {
		// CVE-2025-52903: truth line 63, finding resolved to 78, one function.
		const s = enclosingSpan("runner/runner.go", GO, 10);
		expect(s).toBeDefined();
		expect(s!.start).toBeLessThanOrEqual(10);
		expect(s!.end).toBeGreaterThanOrEqual(18);
	});

	it("puts two lines of one Go function in the same routine", () => {
		expect(sameRoutine("runner/runner.go", GO, 10, 18)).toBe(true);
	});

	it("does not join two different Go functions", () => {
		expect(sameRoutine("runner/runner.go", GO, 10, 26)).toBe(false);
	});

	it("brackets a Python function by indentation", () => {
		expect(sameRoutine("app.py", PY, 7, 9)).toBe(true);
	});

	it("does not join two different Python functions", () => {
		expect(sameRoutine("app.py", PY, 7, 12)).toBe(false);
	});

	it("brackets a Ruby method to its matching end", () => {
		expect(sameRoutine("feed.rb", RB, 3, 4)).toBe(true);
	});

	it("does not join two different Ruby methods", () => {
		expect(sameRoutine("feed.rb", RB, 3, 8)).toBe(false);
	});

	it("declines a line at file scope rather than inventing a span", () => {
		expect(enclosingSpan("runner/runner.go", GO, 1)).toBeUndefined();
	});

	it("declines a language it has no rule for", () => {
		expect(enclosingSpan("config.yml", "a: 1\nb: 2\n", 2)).toBeUndefined();
	});
});
