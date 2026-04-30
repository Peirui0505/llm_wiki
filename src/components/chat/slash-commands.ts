export interface SlashCommandDef {
  command: string
  description: string
  needsPayload?: boolean
}

export const SLASH_COMMANDS: SlashCommandDef[] = [
  { command: "/此时此刻", description: "记录当下片段到 journal", needsPayload: true },
  { command: "/每日复盘", description: "基于最近记录生成每日复盘" },
  { command: "/每周复盘", description: "生成每周复盘总结" },
  { command: "/每月总结", description: "生成每月总结" },
]

export type ReviewCommand = "daily" | "weekly" | "monthly"

export function parseReviewCommand(text: string): ReviewCommand | null {
  const normalized = text.trim()
  if (normalized === "/每日复盘") return "daily"
  if (normalized === "/每周复盘") return "weekly"
  if (normalized === "/每月总结") return "monthly"
  return null
}

export function parseMomentCommand(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith("/此时此刻")) return null
  return trimmed.slice("/此时此刻".length).trim()
}

export function suggestSlashCommands(input: string): SlashCommandDef[] {
  const trimmedStart = input.trimStart()
  if (!trimmedStart.startsWith("/")) return []
  const query = trimmedStart.toLowerCase()
  return SLASH_COMMANDS.filter((c) => c.command.toLowerCase().startsWith(query))
}
