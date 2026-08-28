/**
 * Bridge a core `ToolDefinition` onto pi's `registerTool` shape. Core parameters
 * are plain JSON Schema; pi validates them via its lenient JSON-type path.
 */

import type { ToolDefinition as PiToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import type { HostServices, ToolDefinition } from "../../core/ports.ts";

export function toPiTool(
	tool: ToolDefinition,
	getServices: () => HostServices,
	/** Optional presentation overrides (e.g. a custom result renderer). */
	presentation?: Pick<PiToolDefinition, "renderResult">,
): PiToolDefinition {
	return {
		...presentation,
		name: tool.name,
		label: tool.label ?? tool.name,
		description: tool.description,
		parameters: tool.parameters as unknown as TSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const result = await tool.execute(params, { cwd: ctx.cwd, services: getServices(), signal });
			return {
				content: result.content,
				details: result.details ?? {},
				...(result.terminate ? { terminate: true } : {}),
			};
		},
	};
}
