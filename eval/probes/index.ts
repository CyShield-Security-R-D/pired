/**
 * The T0 probe registry.
 *
 * Order is report order: scope first, because it is the family whose failure is
 * an incident rather than a metric.
 */

import type { Probe } from "../types.ts";
import { continuityProbe } from "./continuity.ts";
import { coverageProbe } from "./coverage.ts";
import { graderProbe } from "./grader.ts";
import { ledgerProbe } from "./ledger.ts";
import { passesProbe } from "./passes.ts";
import { routerProbe } from "./router.ts";
import { scopeProbe } from "./scope.ts";

export const PROBES: Probe[] = [scopeProbe, routerProbe, passesProbe, coverageProbe, continuityProbe, ledgerProbe, graderProbe];
