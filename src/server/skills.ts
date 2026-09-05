import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdapterSkillContext,
  AdapterSkillEntry,
  AdapterSkillSnapshot,
} from "@paperclipai/adapter-utils";
import type { PaperclipSkillEntry } from "@paperclipai/adapter-utils/server-utils";
import {
  readPaperclipRuntimeSkillEntries,
  resolvePaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolve desired skill names for the Kiro adapter.
 * Exported for use by execute.ts to assemble skill content.
 */
export function resolveKiroDesiredSkillNames(
  config: Record<string, unknown>,
  availableSkills: PaperclipSkillEntry[],
): string[] {
  return resolvePaperclipDesiredSkillNames(config, availableSkills);
}

async function buildKiroSkillSnapshot(config: Record<string, unknown>): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const availableByKey = new Map(availableEntries.map((entry) => [entry.key, entry]));
  const desiredSkills = resolvePaperclipDesiredSkillNames(config, availableEntries);
  const desiredSet = new Set(desiredSkills);

  const entries: AdapterSkillEntry[] = availableEntries.map((entry) => ({
    key: entry.key,
    runtimeName: entry.runtimeName,
    desired: desiredSet.has(entry.key),
    managed: true,
    state: desiredSet.has(entry.key) ? "configured" : "available",
    origin: "company_managed",
    originLabel: "Managed by Paperclip",
    readOnly: false,
    sourcePath: entry.source,
    targetPath: null,
    detail: desiredSet.has(entry.key)
      ? "Will be included in the agent prompt on the next run."
      : null,
  }));

  const warnings: string[] = [];

  for (const desiredSkill of desiredSkills) {
    if (availableByKey.has(desiredSkill)) continue;
    warnings.push(`Desired skill "${desiredSkill}" is not available from the Paperclip skills directory.`);
    entries.push({
      key: desiredSkill,
      runtimeName: null,
      desired: true,
      managed: true,
      state: "missing",
      origin: "external_unknown",
      originLabel: "External or unavailable",
      readOnly: false,
      sourcePath: undefined,
      targetPath: undefined,
      detail: "Paperclip cannot find this skill in the local runtime skills directory.",
    });
  }

  entries.sort((left, right) => left.key.localeCompare(right.key));

  return {
    adapterType: "kiro_acp",
    supported: true,
    mode: "ephemeral",
    desiredSkills,
    entries,
    warnings,
  };
}

export async function listKiroSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return buildKiroSkillSnapshot(ctx.config);
}

export async function syncKiroSkills(
  ctx: AdapterSkillContext,
  _desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  return buildKiroSkillSnapshot(ctx.config);
}


/** Inline selected Paperclip skills into Kiro's trusted agent profile. */
export async function assembleKiroSkillContent(
  config: Record<string, unknown>,
): Promise<string | null> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredNames = resolveKiroDesiredSkillNames(config, availableEntries);
  const blocks: string[] = [];
  for (const skillName of desiredNames) {
    const entry = availableEntries.find((candidate) => candidate.key === skillName);
    if (!entry) continue;
    try {
      const content = await fs.readFile(path.join(entry.source, "SKILL.md"), "utf8");
      blocks.push(`<skill name="${entry.runtimeName}">\n${content.trim()}\n</skill>`);
    } catch {
      // Missing/unreadable skills remain visible through listSkills; they do not abort a run.
    }
  }
  return blocks.length > 0 ? `<skills>\n${blocks.join("\n\n")}\n</skills>` : null;
}
