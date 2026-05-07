export interface SlashCommandDef {
  command: string
  description: string
  needsPayload?: boolean
}

export const SLASH_COMMANDS: SlashCommandDef[] = [
  { command: "/此时此刻", description: "记录当下片段到 journal", needsPayload: true },
  { command: "/每日复盘", description: "生成每日复盘（支持 /每日复盘 YYYY-MM-DD）" },
  { command: "/每周复盘", description: "生成每周复盘总结" },
  { command: "/每月总结", description: "生成每月总结（支持 /每月总结 YYYY-MM）" },
  { command: "/每季度复盘", description: "生成每季度复盘（支持 /每季度复盘 YYYY-QN）" },
]

export type ReviewCommand = "daily" | "weekly" | "monthly" | "quarterly"
export interface ReviewCommandRequest {
  command: ReviewCommand
  targetDate?: string
  targetMonth?: string
  targetQuarter?: string
}

function isValidIsoDate(dateText: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText)) return false
  const [y, m, d] = dateText.split("-").map((v) => Number(v))
  const dt = new Date(y, m - 1, d)
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d
}

function isValidIsoMonth(monthText: string): boolean {
  if (!/^\d{4}-\d{2}$/.test(monthText)) return false
  const [y, m] = monthText.split("-").map((v) => Number(v))
  return Number.isInteger(y) && Number.isInteger(m) && m >= 1 && m <= 12
}

function isValidIsoQuarter(quarterText: string): boolean {
  if (!/^\d{4}-Q[1-4]$/.test(quarterText)) return false
  const [yearText, quarterPart] = quarterText.split("-Q")
  const y = Number(yearText)
  const q = Number(quarterPart)
  return Number.isInteger(y) && Number.isInteger(q) && q >= 1 && q <= 4
}

export function parseReviewCommand(text: string): ReviewCommandRequest | null {
  const normalized = text.trim()
  if (normalized === "/每周复盘") return { command: "weekly" }
  const monthlyMatch = normalized.match(/^\/每月总结(?:\s+(\d{4}-\d{2}))?$/)
  if (monthlyMatch) {
    const maybeMonth = monthlyMatch[1]
    if (!maybeMonth) return { command: "monthly" }
    if (isValidIsoMonth(maybeMonth)) return { command: "monthly", targetMonth: maybeMonth }
    return null
  }
  const quarterlyMatch = normalized.match(/^\/每季度复盘(?:\s+(\d{4}-Q[1-4]))?$/)
  if (quarterlyMatch) {
    const maybeQuarter = quarterlyMatch[1]
    if (!maybeQuarter) return { command: "quarterly" }
    if (isValidIsoQuarter(maybeQuarter)) return { command: "quarterly", targetQuarter: maybeQuarter }
    return null
  }

  const dailyMatch = normalized.match(/^\/每日复盘(?:\s+(\d{4}-\d{2}-\d{2}))?$/)
  if (dailyMatch) {
    const maybeDate = dailyMatch[1]
    if (!maybeDate) return { command: "daily" }
    if (isValidIsoDate(maybeDate)) return { command: "daily", targetDate: maybeDate }
    return null
  }

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
