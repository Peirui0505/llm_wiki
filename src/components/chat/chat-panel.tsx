import { useRef, useEffect, useCallback, useState } from "react"
import { BookOpen, Plus, Trash2, MessageSquare, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ChatMessage, StreamingMessage, useSourceFiles } from "./chat-message"
import { ChatInput } from "./chat-input"
import { useChatStore, chatMessagesToLLM, type MessageReference } from "@/stores/chat-store"
import { useWikiStore } from "@/stores/wiki-store"
import { streamChat, type ChatMessage as LLMMessage } from "@/lib/llm-client"
import { executeIngestWrites } from "@/lib/ingest"
import { listDirectory, readFile, deleteFile, createDirectory, writeFile as writeFsFile, writeBase64File } from "@/commands/fs"
import { searchWiki } from "@/lib/search"
import { buildRetrievalGraph, getRelatedNodes } from "@/lib/graph-relevance"
import { normalizePath, getFileName, getRelativePath } from "@/lib/path-utils"
import { getOutputLanguage, buildLanguageDirective, buildLanguageReminder } from "@/lib/output-language"
import { isGreeting } from "@/lib/greeting-detector"
import { parseMomentCommand, parseReviewCommand, type ReviewCommand } from "./slash-commands"

// Store the page mapping from the last query so SourceFilesBar can show which pages were cited
export let lastQueryPages: MessageReference[] = []

function pad2(n: number): string {
  return String(n).padStart(2, "0")
}

function todayIsoDate(): string {
  // Use local date (not UTC) so daily journal/review files align with
  // the user's calendar day in their own timezone.
  const now = new Date()
  const y = now.getFullYear()
  const m = pad2(now.getMonth() + 1)
  const d = pad2(now.getDate())
  return `${y}-${m}-${d}`
}

function startOfToday(): Date {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate())
}

function parseLocalDate(dateText: string): Date {
  const [y, m, d] = dateText.split("-").map((v) => Number(v))
  return new Date(y, m - 1, d)
}

function dayRangeFromIsoDate(dateText: string): { startMs: number; endMs: number } {
  const start = parseLocalDate(dateText)
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1)
  return { startMs: start.getTime(), endMs: end.getTime() }
}

function monthRangeFromIsoMonth(monthText: string): { startMs: number; endMs: number } {
  const [y, m] = monthText.split("-").map((v) => Number(v))
  const start = new Date(y, m - 1, 1)
  const end = new Date(y, m, 1)
  return { startMs: start.getTime(), endMs: end.getTime() }
}

interface QuarterInfo {
  label: string
  start: string
  end: string
  startMs: number
  endMsExclusive: number
  months: string[]
}

function parseIsoQuarter(quarterText: string): { year: number; quarter: number } | null {
  const m = quarterText.match(/^(\d{4})-Q([1-4])$/)
  if (!m) return null
  return { year: Number(m[1]), quarter: Number(m[2]) }
}

function formatIsoDate(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

function buildQuarterInfo(quarterText?: string): QuarterInfo {
  const now = new Date()
  const parsed = quarterText ? parseIsoQuarter(quarterText) : null
  const year = parsed?.year ?? now.getFullYear()
  const quarter = parsed?.quarter ?? Math.floor(now.getMonth() / 3) + 1
  const startMonth = (quarter - 1) * 3
  const startDate = new Date(year, startMonth, 1)
  const endExclusive = new Date(year, startMonth + 3, 1)
  const endDate = new Date(year, startMonth + 3, 0)
  const months = [0, 1, 2].map((i) => `${year}-${pad2(startMonth + i + 1)}`)
  return {
    label: `${year}-Q${quarter}`,
    start: formatIsoDate(startDate),
    end: formatIsoDate(endDate),
    startMs: startDate.getTime(),
    endMsExclusive: endExclusive.getTime(),
    months,
  }
}

async function getQuarterlyNotes(projectPath: string, quarter: QuarterInfo): Promise<string> {
  const pp = normalizePath(projectPath)
  const sections = await Promise.all(
    quarter.months.map(async (month) => {
      const filePath = `${pp}/wiki/personal-growth/reflections/monthly-summary-${month}.md`
      const content = await readFile(filePath).catch(() => "")
      if (content.trim()) return `## ${month} 月复盘\n${content}`
      return `## ${month} 月复盘\n（暂无记录）`
    }),
  )
  return sections.join("\n\n---\n\n")
}

function extractSection(markdown: string, heading: string): string | null {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const re = new RegExp(`^##\\s+${escaped}\\s*$([\\s\\S]*?)(?=^##\\s+|\\Z)`, "m")
  const match = markdown.match(re)
  if (!match) return null
  const body = match[1].trim()
  return body.length > 0 ? body : null
}

function fallbackReviewTemplate(command: ReviewCommand): string {
  if (command === "daily") {
    return [
      "## 1）今日三件推进",
      "- ",
      "- ",
      "- ",
      "",
      "## 2）卡点与根因",
      "- ",
      "",
      "## 3）情绪与能量",
      "- ",
      "",
      "## 4）明日最小行动（<=3条）",
      "- ",
      "- ",
      "- ",
      "",
      "## 5）一句追问（仅一个问题）",
      "- ",
    ].join("\n")
  }
  if (command === "weekly") {
    return [
      "## 1）本周关键进展",
      "- ",
      "- ",
      "",
      "## 2）偏差与风险",
      "- ",
      "",
      "## 3）下周优先级（<=3条）",
      "- ",
      "- ",
      "- ",
      "",
      "## 4）一句追问（仅一个问题）",
      "- ",
    ].join("\n")
  }
  if (command === "quarterly") {
    return [
      "## 1）这个季度用一句话定义",
      "- ",
      "",
      "## 2）三个月的轨迹",
      "- ",
      "",
      "## 3）now页面校准",
      "- ",
      "",
      "## 4）成长了什么",
      "- ",
      "",
      "## 5）下季度最重要的一个赌注",
      "- ",
      "",
      "## 6）一句追问（仅一个问题）",
      "- ",
    ].join("\n")
  }
  return [
    "## 1）本月关键产出",
    "- ",
    "- ",
    "",
    "## 2）模式与教训",
    "- ",
    "",
    "## 3）下月焦点（<=3条）",
    "- ",
    "- ",
    "- ",
    "",
    "## 4）一句追问（仅一个问题）",
    "- ",
  ].join("\n")
}

function resolveReviewTemplate(reviewCommands: string, command: ReviewCommand): string {
  const wantedHeading =
    command === "daily"
      ? "每日复盘"
      : command === "weekly"
        ? "每周复盘"
        : command === "monthly"
          ? "每月总结"
          : "每季度复盘"
  const fromSection = extractSection(reviewCommands, wantedHeading)
  if (fromSection) return fromSection
  return fallbackReviewTemplate(command)
}

function defaultReviewSystemDoc(): string {
  return [
    "# 复盘系统",
    "",
    "## 原则",
    "- 真实优先：如实描述发生了什么，不自我粉饰。",
    "- 可执行优先：每次复盘产出可落地的下一步动作。",
    "- 小步迭代：关注可持续改进，而非一次性完美。",
    "",
    "## 输出要求",
    "- 严格遵守复盘指令模板的标题与顺序。",
    "- 当信息不足时，在对应条目写“信息不足”。",
    "- 追问必须只有一个问题，且不提供答案。",
  ].join("\n")
}

function defaultReviewCommandsDoc(): string {
  return [
    "# 复盘指令",
    "",
    "## 每日复盘",
    fallbackReviewTemplate("daily"),
    "",
    "## 每周复盘",
    fallbackReviewTemplate("weekly"),
    "",
    "## 每月总结",
    fallbackReviewTemplate("monthly"),
    "",
    "## 每季度复盘",
    fallbackReviewTemplate("quarterly"),
  ].join("\n")
}

async function ensureReviewDocs(projectPath: string): Promise<{ reviewSystem: string; reviewCommands: string }> {
  const pp = normalizePath(projectPath)
  const baseDir = `${pp}/wiki/personal-growth`
  const systemPath = `${baseDir}/review-system.md`
  const commandsPath = `${baseDir}/review-commands.md`

  await createDirectory(baseDir).catch(() => {})

  let reviewSystem = await readFile(systemPath).catch(() => "")
  if (!reviewSystem.trim()) {
    reviewSystem = defaultReviewSystemDoc()
    await writeFsFile(systemPath, reviewSystem)
  }

  let reviewCommands = await readFile(commandsPath).catch(() => "")
  if (!reviewCommands.trim()) {
    reviewCommands = defaultReviewCommandsDoc()
    await writeFsFile(commandsPath, reviewCommands)
  }

  return { reviewSystem, reviewCommands }
}

function isoWeekLabel(date: Date): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const dayNum = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const week = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7)
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`
}

function clockLabel(date: Date): string {
  const hh = String(date.getHours()).padStart(2, "0")
  const mm = String(date.getMinutes()).padStart(2, "0")
  return `${hh}:${mm}`
}

function weekdayZh(date: Date): string {
  const labels = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"]
  return labels[date.getDay()]
}

function momentPagePath(projectPath: string, date: string): string {
  const localDate = new Date(`${date}T00:00:00`)
  return `${normalizePath(projectPath)}/wiki/personal-growth/journal/📅${date}·${weekdayZh(localDate)}.md`
}

function sanitizeImageName(name: string): string {
  return name.replace(/[^\w.-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "")
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const out = typeof reader.result === "string" ? reader.result : ""
      const base64 = out.includes(",") ? out.split(",")[1] : out
      resolve(base64)
    }
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read image"))
    reader.readAsDataURL(file)
  })
}

async function appendMomentEntry(projectPath: string, rawContent: string, images: File[] = []): Promise<string> {
  const date = todayIsoDate()
  const path = momentPagePath(projectPath, date)
  const now = new Date()
  const time = clockLabel(now)
  const journalDir = `${normalizePath(projectPath)}/wiki/personal-growth/journal`
  const assetsDir = `${journalDir}/assets`

  const imageLines: string[] = []
  if (images.length > 0) {
    await createDirectory(assetsDir).catch(() => {})
    for (let idx = 0; idx < images.length; idx += 1) {
      const file = images[idx]
      const safe = sanitizeImageName(file.name || `image-${idx + 1}.png`) || `image-${idx + 1}.png`
      const fileName = `${date}-${time.replace(":", "")}-${idx + 1}-${safe}`
      const targetPath = `${assetsDir}/${fileName}`
      const base64 = await fileToBase64(file)
      await writeBase64File(targetPath, base64)
      imageLines.push(`![${safe}](assets/${fileName})`)
    }
  }

  const header = [
    "---",
    "type: journal",
    `title: "此时此刻 ${date}"`,
    `created: ${date}`,
    `updated: ${date}`,
    "source_signal: conversation_crystallized",
    "status: active",
    "tags: [moment, journal]",
    "---",
    "",
    `# 此时此刻 ${date}`,
    "",
  ].join("\n")

  const existing = await readFile(path).catch(() => "")
  const section = [
    `## ${time}`,
    "",
    rawContent.trim() || "(图片记录)",
    ...(imageLines.length > 0 ? ["", "### 图片", "", ...imageLines] : []),
    "",
  ].join("\n")

  const next = existing
    ? `${existing.trimEnd()}\n\n${section}`
    : `${header}${section}`

  await createDirectory(journalDir).catch(() => {})
  await writeFsFile(path, next)
  return path
}

async function autoSaveReviewResult(
  projectPath: string,
  command: ReviewCommand,
  content: string,
  targetDate?: string,
  targetMonth?: string,
  targetQuarter?: string,
): Promise<string> {
  const pp = normalizePath(projectPath)
  const now = new Date()
  const today = todayIsoDate()
  const dailyDate = targetDate ?? today
  const ym = targetMonth ?? (targetDate ? targetDate.slice(0, 7) : today.slice(0, 7))
  const quarter = buildQuarterInfo(targetQuarter)
  const week = isoWeekLabel(targetDate ? parseLocalDate(targetDate) : now)
  const baseDir = `${pp}/wiki/personal-growth/reflections`

  if (command === "daily") {
    const journalPath = momentPagePath(projectPath, dailyDate)
    const journalDir = `${pp}/wiki/personal-growth/journal`
    await createDirectory(journalDir).catch(() => {})
    const existing = await readFile(journalPath).catch(() => "")
    const nowLabel = `${dailyDate === today ? "复盘于" : "补写于"} ${today} ${clockLabel(now)}`
    const reviewSection = [
      "## 每日复盘",
      "",
      `> ${nowLabel}`,
      "",
      content.trim(),
      "",
    ].join("\n")

    const next = existing.trim()
      ? `${existing.trimEnd()}\n\n---\n\n${reviewSection}`
      : [
          "---",
          "type: journal",
          `title: "此时此刻 ${dailyDate}"`,
          `created: ${dailyDate}`,
          `updated: ${today}`,
          "source_signal: conversation_crystallized",
          "status: active",
          "tags: [moment, journal, review]",
          "---",
          "",
          `# 此时此刻 ${dailyDate}`,
          "",
          reviewSection,
        ].join("\n")

    await writeFsFile(journalPath, next)
    return journalPath
  }

  await createDirectory(baseDir).catch(() => {})

  const fileName =
    command === "weekly"
      ? `weekly-review-${week}.md`
      : command === "monthly"
        ? `monthly-summary-${ym}.md`
        : `quarterly-review-${quarter.label}.md`

  const title =
    command === "weekly"
      ? `每周复盘 ${week}`
      : command === "monthly"
        ? `每月总结 ${ym}`
        : `每季度复盘 ${quarter.label}`

  const pageType = "synthesis"
  const frontmatter = [
    "---",
    `type: ${pageType}`,
    `title: "${title}"`,
    `created: ${today}`,
    `updated: ${today}`,
    `source_signal: conversation_crystallized`,
    `status: active`,
    `tags: [review]`,
    "---",
    "",
  ].join("\n")

  const targetPath = `${baseDir}/${fileName}`
  await writeFsFile(targetPath, frontmatter + content.trim() + "\n")
  return targetPath
}

function formatDate(timestamp: number): string {
  const d = new Date(timestamp)
  const now = new Date()
  const isToday = d.toDateString() === now.toDateString()
  if (isToday) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" })
}

function ConversationSidebar() {
  const conversations = useChatStore((s) => s.conversations)
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const messages = useChatStore((s) => s.messages)
  const createConversation = useChatStore((s) => s.createConversation)
  const deleteConversation = useChatStore((s) => s.deleteConversation)
  const setActiveConversation = useChatStore((s) => s.setActiveConversation)

  const [hoveredId, setHoveredId] = useState<string | null>(null)

  const sorted = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt)

  function getMessageCount(convId: string): number {
    return messages.filter((m) => m.conversationId === convId).length
  }

  return (
    <div className="flex h-full w-[200px] flex-shrink-0 flex-col border-r bg-muted/30">
      <div className="border-b p-2">
        <Button
          variant="outline"
          size="sm"
          className="w-full gap-2"
          onClick={() => createConversation()}
        >
          <Plus className="h-3.5 w-3.5" />
          New Chat
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {sorted.length === 0 ? (
          <p className="px-3 py-4 text-xs text-muted-foreground text-center">
            No conversations yet
          </p>
        ) : (
          sorted.map((conv) => {
            const isActive = conv.id === activeConversationId
            const msgCount = getMessageCount(conv.id)
            return (
              <div
                key={conv.id}
                className={`group relative mx-1 my-0.5 flex cursor-pointer flex-col rounded-md px-2 py-1.5 text-sm transition-colors ${
                  isActive
                    ? "bg-primary/10 text-primary"
                    : "hover:bg-accent text-foreground"
                }`}
                onClick={() => setActiveConversation(conv.id)}
                onMouseEnter={() => setHoveredId(conv.id)}
                onMouseLeave={() => setHoveredId(null)}
              >
                <div className="flex items-start justify-between gap-1">
                  <span className="line-clamp-2 flex-1 text-xs font-medium leading-snug">
                    {conv.title}
                  </span>
                  {hoveredId === conv.id && (
                    <button
                      className="flex-shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive"
                      onClick={(e) => {
                        e.stopPropagation()
                        deleteConversation(conv.id)
                        // Delete persisted chat file
                        const proj = useWikiStore.getState().project
                        if (proj) {
                          deleteFile(`${proj.path}/.llm-wiki/chats/${conv.id}.json`).catch(() => {})
                        }
                      }}
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                </div>
                <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                  <span>{formatDate(conv.updatedAt)}</span>
                  {msgCount > 0 && (
                    <>
                      <span>·</span>
                      <span>{msgCount} msgs</span>
                    </>
                  )}
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

export function ChatPanel() {
  useSourceFiles() // Keep source file cache warm
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const streamingContent = useChatStore((s) => s.streamingContent)
  const mode = useChatStore((s) => s.mode)
  const addMessage = useChatStore((s) => s.addMessage)
  const setStreaming = useChatStore((s) => s.setStreaming)
  const appendStreamToken = useChatStore((s) => s.appendStreamToken)
  const finalizeStream = useChatStore((s) => s.finalizeStream)
  const createConversation = useChatStore((s) => s.createConversation)
  const removeLastAssistantMessage = useChatStore((s) => s.removeLastAssistantMessage)
  const maxHistoryMessages = useChatStore((s) => s.maxHistoryMessages)
  const [isWritingToWiki, setIsWritingToWiki] = useState(false)

  // Derive active messages via selector to re-render on message changes
  const allMessages = useChatStore((s) => s.messages)
  const activeMessages = activeConversationId
    ? allMessages.filter((m) => m.conversationId === activeConversationId)
    : []

  const project = useWikiStore((s) => s.project)
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const setFileTree = useWikiStore((s) => s.setFileTree)

  const abortRef = useRef<AbortController | null>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom when messages change or streaming content updates
  useEffect(() => {
    const container = scrollContainerRef.current
    if (container) {
      container.scrollTop = container.scrollHeight
    }
  }, [activeMessages, streamingContent])

  const handleSend = useCallback(
    async (text: string, images: File[] = []) => {
      // Auto-create a conversation if none is active
      let convId = useChatStore.getState().activeConversationId
      if (!convId) {
        convId = createConversation()
      }

      if (text.trim()) {
        addMessage("user", text)
      }
      setStreaming(true)

      const momentPayload = parseMomentCommand(text)
      if (momentPayload !== null && project) {
        setStreaming(false)
        if (!momentPayload && images.length === 0) {
          addMessage("system", "已识别 /此时此刻，但内容为空。请在命令后补充文字，或直接粘贴图片。")
          return
        }
        try {
          const written = await appendMomentEntry(project.path, momentPayload, images)
          const tree = await listDirectory(normalizePath(project.path))
          setFileTree(tree)
          useWikiStore.getState().bumpDataVersion()
          addMessage("system", `已记录到此时此刻：${written}`)
        } catch (err) {
          addMessage("system", `此时此刻记录失败：${err instanceof Error ? err.message : String(err)}`)
        }
        return
      }
      if (images.length > 0) {
        setStreaming(false)
        addMessage("system", "目前仅 `/此时此刻` 支持图片写入。请在命令后发送图片。")
        return
      }

      const reviewCommand = parseReviewCommand(text)
      if (reviewCommand && project) {
        const today = todayIsoDate()
        const reviewDate = reviewCommand.targetDate ?? today
        const reviewMonth = reviewCommand.targetMonth ?? today.slice(0, 7)
        const reviewQuarter = buildQuarterInfo(reviewCommand.targetQuarter)
        let notes = ""
        if (reviewCommand.command === "quarterly") {
          notes = await getQuarterlyNotes(project.path, reviewQuarter)
        } else if (reviewCommand.command === "daily") {
          const momentsPath = momentPagePath(project.path, reviewDate)
          notes = await readFile(momentsPath).catch(() => "")
        }
        if (!notes) {
          const { startMs, endMs } =
            reviewCommand.command === "daily"
              ? dayRangeFromIsoDate(reviewDate)
              : reviewCommand.command === "monthly"
                ? monthRangeFromIsoMonth(reviewMonth)
              : reviewCommand.command === "quarterly"
                ? { startMs: reviewQuarter.startMs, endMs: reviewQuarter.endMsExclusive }
              : { startMs: startOfToday().getTime(), endMs: Number.POSITIVE_INFINITY }
          const activeConvMessages = useChatStore.getState().getActiveMessages()
            .filter(
              (m) =>
                (m.role === "user" || m.role === "assistant") &&
                m.timestamp >= startMs &&
                m.timestamp < endMs,
            )
          notes = activeConvMessages
            .filter((m) => {
              const trimmed = m.content.trim()
              return (
                !trimmed.startsWith("/每日复盘") &&
                trimmed !== "/每周复盘" &&
                !trimmed.startsWith("/每月总结") &&
                !trimmed.startsWith("/每季度复盘")
              )
            })
            .map((m) => `${m.role === "user" ? "我" : "助手"}: ${m.content}`)
            .join("\n\n")
        }

        const cmdTitle =
          reviewCommand.command === "daily"
            ? `每日复盘${reviewCommand.targetDate ? `（${reviewCommand.targetDate}）` : ""}`
            : reviewCommand.command === "weekly"
              ? "每周复盘"
              : reviewCommand.command === "monthly"
                ? `每月总结${reviewCommand.targetMonth ? `（${reviewCommand.targetMonth}）` : ""}`
                : `每季度复盘${reviewCommand.targetQuarter ? `（${reviewCommand.targetQuarter}）` : ""}`
        const { reviewSystem, reviewCommands } = await ensureReviewDocs(project.path)
        const strictTemplate = resolveReviewTemplate(reviewCommands, reviewCommand.command)

        const controller = new AbortController()
        abortRef.current = controller
        let accumulated = ""
        await streamChat(
          llmConfig,
          [
            {
              role: "system",
              content: [
                "你是用户的复盘诤友。严格按给定模板输出，不要额外解释。",
                "当记录不足时，也要按模板输出，并在对应字段写“信息不足”。",
                "追问必须只有一个问题，且不提供答案或建议。",
                "你必须严格遵守下方“输出模板骨架”：",
                "- 保留全部标题及顺序，不得改写标题文字。",
                "- 不得新增标题，不得删除标题。",
                "- 只能在每个标题下填写内容。",
                reviewSystem ? `## Review System\n${reviewSystem}` : "",
                "## 输出模板骨架",
                strictTemplate,
                reviewCommands ? `## Review Commands（参考）\n${reviewCommands}` : "",
              ].filter(Boolean).join("\n\n"),
            },
            {
              role: "user",
              content: [
                `请执行：${cmdTitle}`,
                "",
                `目标日期：${
                  reviewCommand.command === "monthly"
                    ? reviewMonth
                    : reviewCommand.command === "quarterly"
                      ? `${reviewQuarter.start} ~ ${reviewQuarter.end} (${reviewQuarter.label})`
                      : reviewDate
                }`,
                "",
                "以下是该日期范围内的碎片记录，请据此生成复盘：",
                notes || "(暂无记录)",
              ].join("\n"),
            },
          ],
          {
            onToken: (token) => {
              accumulated += token
              appendStreamToken(token)
            },
            onDone: async () => {
              finalizeStream(accumulated)
              abortRef.current = null
              try {
                const written = await autoSaveReviewResult(
                  project.path,
                  reviewCommand.command,
                  accumulated,
                  reviewCommand.targetDate,
                  reviewCommand.targetMonth,
                  reviewCommand.targetQuarter,
                )
                const tree = await listDirectory(normalizePath(project.path))
                setFileTree(tree)
                useWikiStore.getState().bumpDataVersion()
                useChatStore.getState().addMessage("system", `复盘已自动保存：${written}`)
              } catch (err) {
                useChatStore.getState().addMessage("system", `复盘自动保存失败：${err instanceof Error ? err.message : String(err)}`)
              }
            },
            onError: (err) => {
              finalizeStream(`Error: ${err.message}`, undefined)
              abortRef.current = null
            },
          },
          controller.signal,
        )
        return
      }

      // Build system prompt with wiki context using graph-enhanced retrieval
      const systemMessages: LLMMessage[] = []
      let queryRefs: MessageReference[] = []
      let langReminder: string | undefined
      // Pure greetings ("hi", "你好", "嗨") don't warrant running the whole
      // retrieval pipeline — it's slow, costs context, and drags in random
      // wiki pages the user clearly didn't ask about. Short-circuit with a
      // minimal system prompt and let the model reply conversationally.
      const greetingOnly = isGreeting(text)
      if (project && greetingOnly) {
        const outLang = getOutputLanguage(text)
        systemMessages.push({
          role: "system",
          content: [
            `You are a wiki assistant for the project "${project.name}".`,
            "The user sent a casual greeting — reply briefly and naturally, in one or two sentences.",
            "Do NOT invent wiki content or pretend to have retrieved pages. Invite the user to ask a concrete question if they want information from the wiki.",
            "",
            `Respond in ${outLang}.`,
          ].join("\n"),
        })
        // Skip retrieval; queryRefs stays empty so no "Sources" chip is shown.
      } else if (project) {
        const pp = normalizePath(project.path)
        const dataVersion = useWikiStore.getState().dataVersion
        const maxCtx = llmConfig.maxContextSize || 204800

        // ── Budget allocation ──────────────────────────────────
        const INDEX_BUDGET = Math.floor(maxCtx * 0.05)
        const PAGE_BUDGET = Math.floor(maxCtx * 0.6)
        const MAX_PAGE_SIZE = Math.min(Math.floor(PAGE_BUDGET * 0.3), 30_000)

        const [rawIndex, purpose] = await Promise.all([
          readFile(`${pp}/wiki/index.md`).catch(() => ""),
          readFile(`${pp}/purpose.md`).catch(() => ""),
        ])

        // ── Phase 1: Tokenized search → top 10 ────────────────
        const searchResults = await searchWiki(pp, text)
        const topSearchResults = searchResults.slice(0, 10)

        // ── Trim index by relevance if over budget ─────────────
        let index = rawIndex
        if (rawIndex.length > INDEX_BUDGET) {
          const { tokenizeQuery } = await import("@/lib/search")
          const tokens = tokenizeQuery(text)
          const lines = rawIndex.split("\n")
          const keptLines: string[] = []
          let keptSize = 0

          for (const line of lines) {
            const isHeader = line.startsWith("##")
            const lower = line.toLowerCase()
            const isRelevant = tokens.some((t) => lower.includes(t))

            if (isHeader || isRelevant) {
              if (keptSize + line.length + 1 <= INDEX_BUDGET) {
                keptLines.push(line)
                keptSize += line.length + 1
              }
            }
          }
          index = keptLines.join("\n")
          if (index.length < rawIndex.length) {
            index += "\n\n[...index trimmed to relevant entries...]"
          }
        }

        // ── Phase 2: Graph 1-level expansion ───────────────────
        // Note: Vector search (if enabled) is already merged into searchResults
        // by searchWiki() in search.ts — no duplicate code needed here.
        const graph = await buildRetrievalGraph(pp, dataVersion)
        const expandedIds = new Set<string>()
        const searchHitPaths = new Set(topSearchResults.map((r) => r.path))
        const graphExpansions: { title: string; path: string; relevance: number }[] = []

        for (const result of topSearchResults) {
          const fileName = getFileName(result.path)
          const nodeId = fileName.replace(/\.md$/, "")
          const related = getRelatedNodes(nodeId, graph, 3)
          for (const { node, relevance } of related) {
            if (relevance < 2.0) continue
            if (searchHitPaths.has(node.path)) continue
            if (expandedIds.has(node.id)) continue
            expandedIds.add(node.id)
            graphExpansions.push({ title: node.title, path: node.path, relevance })
          }
        }
        graphExpansions.sort((a, b) => b.relevance - a.relevance)

        // ── Phase 3 & 4: Page budget control ───────────────────
        let usedChars = 0
        type PageEntry = {
          title: string
          path: string
          content: string
          priority: number
          snippet?: string
          score?: number
        }
        const relevantPages: PageEntry[] = []

        const tryAddPage = async (
          title: string,
          filePath: string,
          priority: number,
          snippet?: string,
          score?: number,
        ): Promise<boolean> => {
          if (usedChars >= PAGE_BUDGET) return false
          try {
            const raw = await readFile(filePath)
            const relativePath = getRelativePath(filePath, pp)
            const truncated = raw.length > MAX_PAGE_SIZE
              ? raw.slice(0, MAX_PAGE_SIZE) + "\n\n[...truncated...]"
              : raw
            if (usedChars + truncated.length > PAGE_BUDGET) return false
            usedChars += truncated.length
            relevantPages.push({ title, path: relativePath, content: truncated, priority, snippet, score })
            return true
          } catch { return false }
        }

        // P0: Title matches
        for (const r of topSearchResults.filter((r) => r.titleMatch)) {
          await tryAddPage(r.title, r.path, 0, r.snippet, r.score)
        }
        // P1: Content matches
        for (const r of topSearchResults.filter((r) => !r.titleMatch)) {
          await tryAddPage(r.title, r.path, 1, r.snippet, r.score)
        }
        // P2: Graph expansions
        for (const exp of graphExpansions) {
          await tryAddPage(exp.title, exp.path, 2, undefined, exp.relevance)
        }
        // P3: Overview fallback
        if (relevantPages.length === 0) {
          await tryAddPage("Overview", `${pp}/wiki/overview.md`, 3)
        }

        const pagesContext = relevantPages.length > 0
          ? relevantPages.map((p, i) =>
              `### [${i + 1}] ${p.title}\nPath: ${p.path}\n\n${p.content}`
            ).join("\n\n---\n\n")
          : "(No wiki pages found)"

        const pageList = relevantPages.map((p, i) =>
          `[${i + 1}] ${p.title} (${p.path})`
        ).join("\n")

        systemMessages.push({
          role: "system",
          content: [
            "You are a knowledgeable wiki assistant. Answer questions based on the wiki content provided below.",
            "",
            "## Rules",
            "- Answer based ONLY on the numbered wiki pages provided below.",
            "- If the provided pages don't contain enough information, say so honestly.",
            "- Use [[wikilink]] syntax to reference wiki pages.",
            "- When citing information, use the page number in brackets, e.g. [1], [2].",
            "- At the VERY END of your response, add a hidden comment listing which page numbers you used:",
            "  <!-- cited: 1, 3, 5 -->",
            "",
            "Use markdown formatting for clarity.",
            "",
            purpose ? `## Wiki Purpose\n${purpose}` : "",
            index ? `## Wiki Index\n${index}` : "",
            relevantPages.length > 0 ? `## Page List\n${pageList}` : "",
            `## Wiki Pages\n\n${pagesContext}`,
            "",
            "---",
            "",
            buildLanguageDirective(text),
          ].filter(Boolean).join("\n"),
        })

        // Reminder injected later, right before the user's current message
        // (after history so it's the last system instruction the LLM sees).
        langReminder = buildLanguageReminder(text)

        lastQueryPages = relevantPages.map((p) => ({
          title: p.title,
          path: p.path,
          snippet: p.snippet,
          score: p.score,
        }))
        queryRefs = [...lastQueryPages]
      }

      // ── Conversation history with count limit ────────────────
      // Only include messages from the active conversation, last N messages
      const activeConvMessages = useChatStore.getState().getActiveMessages()
        .filter((m) => m.role === "user" || m.role === "assistant")
        .slice(-maxHistoryMessages)

      // Prepend the language reminder onto the final user turn rather than
      // inserting a second {role:"system"} between history and the final
      // user message. vLLM / llama.cpp / Ollama drive their chat templates
      // from HF Jinja, and Qwen3-family templates enforce "system only at
      // index 0" — a mid-conversation system message gets rejected with
      // "System message must be at the beginning." (HTTP 400). OpenAI and
      // Anthropic are more lenient, but keeping a single system at the top
      // is the safest shape across every OpenAI-compatible backend.
      const historyMessages = chatMessagesToLLM(activeConvMessages)
      let llmMessages: LLMMessage[] = [...systemMessages, ...historyMessages]
      if (langReminder && historyMessages.length > 0) {
        const lastIdx = llmMessages.length - 1
        const last = llmMessages[lastIdx]
        if (last && last.role === "user") {
          llmMessages = [
            ...llmMessages.slice(0, lastIdx),
            { role: "user", content: `[${langReminder}]\n\n${last.content}` },
          ]
        }
      }

      const controller = new AbortController()
      abortRef.current = controller

      let accumulated = ""

      await streamChat(
        llmConfig,
        llmMessages,
        {
          onToken: (token) => {
            accumulated += token
            appendStreamToken(token)
          },
          onDone: () => {
            finalizeStream(accumulated, queryRefs)
            abortRef.current = null
            // save-worthy detection removed — user has direct "Save to Wiki" button on each message
          },
          onError: (err) => {
            finalizeStream(`Error: ${err.message}`, undefined)
            abortRef.current = null
          },
        },
        controller.signal,
      )
    },
    [llmConfig, addMessage, setStreaming, appendStreamToken, finalizeStream, createConversation, maxHistoryMessages],
  )

  const handleStop = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
  }, [])

  const handleRegenerate = useCallback(async () => {
    if (isStreaming) return
    // Find the last user message in active conversation
    const active = useChatStore.getState().getActiveMessages()
    const lastUserMsg = [...active].reverse().find((m) => m.role === "user")
    if (!lastUserMsg) return
    // Remove the last assistant reply, then re-send
    removeLastAssistantMessage()
    // Small delay to let state update
    await new Promise((r) => setTimeout(r, 50))
    // Trigger send with the same text (handleSend will add a new user message,
    // so also remove the original to avoid duplication)
    // Actually: just call handleSend — but it adds a user message. To avoid dupe,
    // we remove the last user message too and let handleSend re-add it.
    const store = useChatStore.getState()
    const updatedActive = store.getActiveMessages()
    const lastUser = [...updatedActive].reverse().find((m) => m.role === "user")
    if (lastUser) {
      useChatStore.setState((s) => ({
        messages: s.messages.filter((m) => m.id !== lastUser.id),
      }))
    }
    handleSend(lastUserMsg.content)
  }, [isStreaming, removeLastAssistantMessage, handleSend])

  const handleWriteToWiki = useCallback(async () => {
    if (!project || isWritingToWiki) return
    const pp = normalizePath(project.path)
    setIsWritingToWiki(true)
    addMessage("system", "正在根据当前 ingest 对话生成 FILE blocks 并写入 wiki，请稍候…")
    try {
      await executeIngestWrites(pp, llmConfig, undefined, undefined)
      try {
        const tree = await listDirectory(pp)
        setFileTree(tree)
      } catch {
        // ignore
      }
    } catch (err) {
      console.error("Failed to write to wiki:", err)
      addMessage("system", `Write to Wiki 失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setIsWritingToWiki(false)
    }
  }, [project, llmConfig, setFileTree, addMessage, isWritingToWiki])

  const hasAssistantMessages = activeMessages.some((m) => m.role === "assistant")
  const showWriteButton = mode === "ingest" && !isStreaming && hasAssistantMessages

  return (
    <div className="flex h-full flex-row overflow-hidden">
      <ConversationSidebar />

      <div className="flex flex-1 flex-col overflow-hidden">
        {!activeConversationId ? (
          <div className="flex flex-1 items-center justify-center text-muted-foreground">
            <div className="text-center">
              <MessageSquare className="mx-auto mb-3 h-8 w-8 opacity-30" />
              <p className="text-sm">Start a new conversation</p>
              <p className="mt-1 text-xs opacity-60">Click "New Chat" to begin</p>
            </div>
          </div>
        ) : (
          <>
            <div
              ref={scrollContainerRef}
              className="flex-1 overflow-y-auto px-4 py-4"
            >
              <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-5">
                {activeMessages.map((msg, idx) => {
                  // Check if this is the last assistant message
                  const isLastAssistant = msg.role === "assistant" &&
                    !activeMessages.slice(idx + 1).some((m) => m.role === "assistant")
                  return (
                    <ChatMessage
                      key={msg.id}
                      message={msg}
                      isLastAssistant={isLastAssistant && !isStreaming}
                      onRegenerate={isLastAssistant ? handleRegenerate : undefined}
                    />
                  )
                })}
                {isStreaming && <StreamingMessage content={streamingContent} />}
                <div ref={bottomRef} />
              </div>
            </div>

            {showWriteButton && (
              <div className="border-t px-3 py-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleWriteToWiki}
                  disabled={isWritingToWiki}
                  className="w-full gap-2"
                >
                  {isWritingToWiki ? <Loader2 className="h-4 w-4 animate-spin" /> : <BookOpen className="h-4 w-4" />}
                  {isWritingToWiki ? "Writing..." : "Write to Wiki"}
                </Button>
              </div>
            )}
          </>
        )}

        <ChatInput
          onSend={handleSend}
          onStop={handleStop}
          isStreaming={isStreaming}
          placeholder={
            mode === "ingest"
              ? "Discuss the source or ask follow-up questions..."
              : "Type a message..."
          }
        />
      </div>
    </div>
  )
}

