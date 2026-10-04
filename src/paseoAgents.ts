import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import process from "node:process";

/**
 * Native session ids of agents the Paseo daemon owns, read from its agent
 * records ($PASEO_HOME/agents/<project>/<agentId>.json, field
 * persistence.sessionId). The agentdash Paseo plugin already reports these
 * agents, so the emitter's pollers skip them to avoid duplicate widget rows.
 *
 * Archived agents are included on purpose: their sessions belong to Paseo
 * too. Unreadable or malformed files are skipped; a missing directory yields
 * an empty set (fail open: duplicates rather than missing rows).
 */
export function paseoSessionIds(
  agentsDir = join(process.env.PASEO_HOME ?? join(homedir(), ".paseo"), "agents"),
): Set<string> {
  const ids = new Set<string>();
  let projects: string[];
  try {
    projects = readdirSync(agentsDir);
  } catch {
    return ids;
  }
  for (const project of projects) {
    let files: string[];
    try {
      files = readdirSync(join(agentsDir, project));
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const record = JSON.parse(readFileSync(join(agentsDir, project, file), "utf-8"));
        const id = record?.persistence?.sessionId;
        if (typeof id === "string" && id) ids.add(id);
      } catch {
        // skip unreadable/partial record
      }
    }
  }
  return ids;
}
