// Grok Bot's assembled system prompt (~70KB) is written for its own runner
// tools (Shell, update_state, question widgets, approval cards). Replaying it
// to VCoder as "earlier messages" buried the bot's identity and teammates in a
// low-weight history blob that was only sent on the first turn of a session.
// This extracts the per-agent parts that matter for acting as a team member —
// group-room persona, agent profile, time zone, teammate directory — rewrites
// tool names to what VCoder actually has, and returns text that is injected
// into every turn.

const SECTION_BREAK = /\n\n(?=## |Agent profile:|Your teammates:)/;

function rewriteForVCoder(text: string): string {
  return text
    .replace(/\bSendMessage\b/g, "SendUserMessage")
    .replace(/\bSendToAgent\b/g, "SendToAgent (sand_agents MCP tool)")
    .replace(/, with Shell —/g, ", with your Read/Bash tools —")
    .replace(/with one question widget naming/g, "with one short SendUserMessage naming")
    .replace(/ To change your OWN name, description, or persona, use update_state[^.]*\.[^.]*\./g, "");
}

function takeSection(prompt: string, start: string): string | null {
  const index = prompt.indexOf(start);
  if (index < 0) return null;
  const rest = prompt.slice(index);
  const end = rest.slice(start.length).search(SECTION_BREAK);
  return (end < 0 ? rest : rest.slice(0, start.length + end)).trim();
}

function groupPreamble(prompt: string): string | null {
  if (!/^You are .+, one participant in a group chat/.test(prompt)) return null;
  const end = prompt.search(/\n\n## /);
  return (end < 0 ? prompt : prompt.slice(0, end)).trim();
}

function profileEssentials(section: string | null): string | null {
  if (section == null) return null;
  // Keep identity lines; drop the config-file/avatar/settings instructions
  // that reference update_state, which VCoder does not have.
  const cut = section.search(/\nYour profile is a JSON config file/);
  return (cut < 0 ? section : section.slice(0, cut)).trim();
}

function rosterLines(section: string | null): string | null {
  if (section == null) return null;
  // The long messaging rules are static and live in the VCoder output style;
  // only the live roster (which changes as bots/groups are added) goes here.
  const start = section.search(/^(Teammates you can message right now:|Group chats you're in|This user has no other agents yet)/m);
  return start < 0 ? null : section.slice(start).trim();
}

export function vcoderAgentContextFromSystemPrompt(systemPrompt: string): string | null {
  const prompt = systemPrompt.trim();
  if (prompt.length === 0) return null;
  const parts = [
    groupPreamble(prompt),
    profileEssentials(takeSection(prompt, "Agent profile:")),
    takeSection(prompt, "## Time"),
    rosterLines(takeSection(prompt, "Your teammates:")),
  ].filter((part): part is string => part != null && part.length > 0);
  return parts.length === 0 ? null : rewriteForVCoder(parts.join("\n\n"));
}
