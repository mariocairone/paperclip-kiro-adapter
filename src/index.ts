import type { ServerAdapterModule } from "@paperclipai/adapter-utils";
import {
  discoverKiroModels,
  FALLBACK_KIRO_MODELS,
  KIRO_EFFORT_LEVELS,
  refreshKiroModels,
} from "./model.js";
import { execute } from "./server/execute.js";
import { getConfigSchema } from "./server/config-schema.js";
import { sessionCodec } from "./server/session-codec.js";
import { listKiroSkills, syncKiroSkills } from "./server/skills.js";
import { testEnvironment } from "./server/test.js";

export const type = "kiro_acp";
export const label = "Kiro ACP";
export const models = FALLBACK_KIRO_MODELS;

export const agentConfigurationDoc = `# kiro_acp agent configuration

Adapter: kiro_acp (external package \`@mariocairone/paperclip-kiro-adapter\`)

Execution engines:
- \`engine: auto\` (default) uses \`kiro-cli acp\`. It falls back to the legacy CLI wrapper only when the installed binary explicitly reports that the \`acp\` subcommand is unavailable.
- \`engine: acp\` requires ACP and fails closed; it never falls back.
- \`engine: cli\` selects the original \`kiro-cli chat\` wrapper.

Core fields:
- \`baseAgent\`: optional Markdown/JSON Kiro agent. Prompt/persona, model, tools, allowedTools, MCP servers, resources, tool aliases, tool settings, includeMcpJson, and requireMcpStartup are inherited. An explicit Paperclip model overrides the base model; \`auto\` inherits it.
- Standard Paperclip \`Thinking effort\` is the only visible effort control. The runtime accepts \`${KIRO_EFFORT_LEVELS.join(", ")}\`; legacy \`kiroEffort\` is read only for migration compatibility. Invalid values are rejected by the environment test and omitted with a run warning.
- \`trustTools\`: comma-separated string or string array for Kiro's \`--trust-tools\`. Unset preserves the compatible \`--trust-all-tools\` default. An explicit empty list emits no Kiro trust flag.
- \`requireMcpStartup\`: requires at least one MCP server and writes the flag into the Kiro profile for Kiro versions that honor it.
- \`preferConfiguredCwd\`: configured cwd overrides the Paperclip workspace.
- \`extraArgs\`: additional Kiro flags, except adapter-owned \`--agent\`, \`--model\`, \`--effort\`, \`--resume-id\`, \`--output-format\`, and \`--no-interactive\`.

ACP details:
- Model and effort are startup flags on \`kiro-cli acp\`; they are fixed for the ACP session. They are removed from acpx-engine config so Kiro is never sent unsupported \`session/set_config_option\` calls.
- The profile name is stable per Paperclip agent. Profile content changes invalidate the ACP session fingerprint. Profiles are written atomically with mode 0600 under \`$KIRO_HOME/agents\` (or \`~/.kiro/agents\`) and stale adapter-owned profiles are swept safely.
- The system prompt contains the inherited base persona, selected Paperclip skills, and managed instructions. Base-agent MCP definitions win name collisions; every available MCP server is named in tools/allowedTools.
- ACP session ids and tool events come from typed ACP/acpx metadata. The ACP lane never runs \`chat --list-sessions\`.
- Kiro 2.21.0 emits private typed \`_kiro.dev/metadata.meteringUsage\` credit metadata, but acpx 0.12.0 does not expose that notification through \`AcpRuntimeEvent\` or status. \`resultJson.usageJson\` therefore stays null unless acpx surfaces standard typed usage; the adapter does not parse private protocol traffic or invent usage.
`;

export { execute, getConfigSchema, listKiroSkills, sessionCodec, syncKiroSkills, testEnvironment };

export function createServerAdapter(): ServerAdapterModule {
  return {
    type,
    execute,
    testEnvironment,
    sessionCodec,
    listSkills: listKiroSkills,
    syncSkills: syncKiroSkills,
    models,
    listModels: discoverKiroModels,
    refreshModels: refreshKiroModels,
    agentConfigurationDoc,
    getConfigSchema,
    supportsLocalAgentJwt: true,
    supportsInstructionsBundle: true,
    instructionsPathKey: "instructionsFilePath",
    acp: {
      agentId: "kiro",
      skillsMode: "ephemeral",
      prerequisites: { nodeRange: ">=22.13.0" },
    },
  };
}
