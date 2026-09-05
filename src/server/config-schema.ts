import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";
import { KIRO_EFFORT_LEVELS } from "../model.js";

/** Adapter-specific fields only; Paperclip renders command/model/cwd/instructions/extraArgs. */
export function getConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "engine",
        label: "Execution engine",
        type: "select",
        default: "auto",
        options: [
          { value: "auto", label: "Auto (ACP, CLI only when ACP is unavailable)" },
          { value: "acp", label: "ACP required (fail closed)" },
          { value: "cli", label: "CLI wrapper" },
        ],
        hint: "Auto falls back only when the installed Kiro CLI has no acp subcommand.",
      },
      {
        key: "baseAgent",
        label: "Base Kiro agent",
        type: "text",
        hint: "Optional Kiro agent name. Prompt, model, tools, allowedTools, MCP, resources, aliases, settings, and includeMcpJson are inherited.",
      },
      {
        key: "trustTools",
        label: "Trusted Kiro tools",
        type: "text",
        hint: "Comma-separated tool names for --trust-tools. Unset preserves the compatible --trust-all-tools default; an empty value requests no Kiro-side trust flag.",
      },
      {
        key: "requireMcpStartup",
        label: "Require MCP startup",
        type: "toggle",
        default: false,
        hint: "Fail before launch when no MCP server is configured and pass requireMcpStartup into the Kiro agent profile for Kiro versions that support it.",
      },
      {
        key: "preferConfiguredCwd",
        label: "Always use configured working directory",
        type: "toggle",
        default: false,
        hint: "Override Paperclip's issue/workspace directory with the configured cwd.",
      },
      {
        key: "permissionMode",
        label: "ACP permission mode",
        type: "select",
        default: "approve-all",
        options: [
          { value: "approve-all", label: "Approve all" },
          { value: "approve-reads", label: "Approve reads" },
          { value: "deny-all", label: "Deny all" },
        ],
        hint: "ACPX client-side permission policy. Kiro-side trustTools is applied first.",
      },
      {
        key: "nonInteractivePermissions",
        label: "Non-interactive permission fallback",
        type: "select",
        default: "deny",
        options: [
          { value: "deny", label: "Deny" },
          { value: "fail", label: "Fail run" },
        ],
      },
      {
        key: "timeoutSec",
        label: "Timeout (seconds)",
        type: "number",
        default: 0,
        hint: "Hard limit for one heartbeat. 0 disables the adapter timeout.",
      },
      {
        key: "graceSec",
        label: "SIGTERM grace (seconds)",
        type: "number",
        default: 20,
        hint: "CLI fallback shutdown grace period.",
      },
      {
        key: "logLineLimit",
        label: "CLI log line limit (characters)",
        type: "number",
        default: 2000,
        hint: "CLI fallback only. 0 disables truncation.",
      },
    ],
  };
}
