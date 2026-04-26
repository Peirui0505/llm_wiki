import { open } from "@tauri-apps/plugin-dialog"
import { fetchTranscript } from "youtube-transcript"
import { copyFile, fileExists, listDirectory, preprocessFile, writeFile } from "@/commands/fs"
import { enqueueIngest } from "@/lib/ingest-queue"
import { getHttpFetch, isFetchNetworkError } from "@/lib/tauri-fetch"
import { getFileName, normalizePath } from "@/lib/path-utils"
import { useWikiStore } from "@/stores/wiki-store"

type IngestType = "link" | "file" | "note"
type IngestMode = "save" | "analyze"

interface IngestContext {
  type: IngestType
  payload: any
  mode: IngestMode
}

export interface IngestEntryResult {
  warnings: string[]
}

type LinkPlatform = "youtube" | "wechat" | "x" | "douyin_family" | "generic"

function hasLlmConfigured(): boolean {
  const llm = useWikiStore.getState().llmConfig
  return !!llm.apiKey || llm.provider === "ollama" || llm.provider === "custom"
}

function sanitizeBaseName(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\-_\u4e00-\u9fa5]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
  return cleaned || "untitled"
}

function nowStamp(): string {
  const d = new Date()
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, "0")
  const dd = String(d.getDate()).padStart(2, "0")
  const hh = String(d.getHours()).padStart(2, "0")
  const mi = String(d.getMinutes()).padStart(2, "0")
  const ss = String(d.getSeconds()).padStart(2, "0")
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`
}

function extractNoteTitle(content: string): string {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (lines.length === 0) return "note"

  const heading = lines.find((line) => /^#{1,6}\s+/.test(line))
  if (heading) return heading.replace(/^#{1,6}\s+/, "").trim() || "note"

  return lines[0]
}

async function uniquePath(dir: string, baseName: string, ext: string): Promise<string> {
  const stem = sanitizeBaseName(baseName)
  const extension = ext.startsWith(".") ? ext : `.${ext}`
  const first = `${dir}/${stem}${extension}`
  if (!(await fileExists(first))) return first
  const stamp = nowStamp()
  const second = `${dir}/${stem}-${stamp}${extension}`
  if (!(await fileExists(second))) return second
  let i = 2
  while (i < 999) {
    const candidate = `${dir}/${stem}-${stamp}-${i}${extension}`
    if (!(await fileExists(candidate))) return candidate
    i += 1
  }
  return `${dir}/${stem}-${Date.now()}${extension}`
}

function htmlToText(html: string): string {
  const noScript = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
  return noScript
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim()
}

function extractTitle(html: string, fallbackUrl: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = match?.[1]?.replace(/\s+/g, " ").trim()
  if (title) return title.slice(0, 120)
  try {
    const url = new URL(fallbackUrl)
    return url.hostname
  } catch {
    return "web-link"
  }
}

function detectLinkPlatform(rawUrl: string): LinkPlatform {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase()
    if (host.includes("youtube.com") || host.includes("youtu.be")) return "youtube"
    if (host.includes("mp.weixin.qq.com")) return "wechat"
    if (host.includes("x.com") || host.includes("twitter.com")) return "x"
    if (
      host.includes("douyin.com") ||
      host.includes("iesdouyin.com") ||
      host.includes("tiktok.com") ||
      host.includes("bilibili.com") ||
      host.includes("b23.tv")
    ) {
      return "douyin_family"
    }
  } catch {
    // fallback generic
  }
  return "generic"
}

function secondsToTimestamp(sec: number): string {
  const safe = Math.max(0, Math.floor(sec))
  const hh = String(Math.floor(safe / 3600)).padStart(2, "0")
  const mm = String(Math.floor((safe % 3600) / 60)).padStart(2, "0")
  const ss = String(safe % 60).padStart(2, "0")
  return `${hh}:${mm}:${ss}`
}

function detectPrivacyRisks(text: string): string[] {
  const risks: string[] = []
  const checks: Array<{ label: string; re: RegExp }> = [
    { label: "疑似 API Key（sk-）", re: /\bsk-[a-zA-Z0-9]{16,}\b/g },
    { label: "疑似 Bearer Token", re: /\bBearer\s+[A-Za-z0-9\-_\.=]{20,}\b/g },
    { label: "疑似手机号（中国大陆）", re: /\b1[3-9]\d{9}\b/g },
    { label: "疑似邮箱", re: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
    { label: "疑似身份证号", re: /\b\d{17}[\dXx]\b/g },
  ]
  for (const c of checks) {
    if (c.re.test(text)) risks.push(c.label)
  }
  return risks
}

async function fetchYouTubeTitle(url: string): Promise<string> {
  const httpFetch = await getHttpFetch()
  const endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`
  const response = await httpFetch(endpoint, { method: "GET" })
  if (!response.ok) return "youtube-video"
  const data = (await response.json()) as { title?: string }
  return (data.title ?? "youtube-video").trim() || "youtube-video"
}

async function saveYouTubeLink(projectId: string, projectPath: string, url: string, mode: IngestMode, warnings: string[]): Promise<void> {
  const httpFetch = await getHttpFetch()
  let transcriptItems: Array<{ text?: string; offset?: number; start?: number }> = []
  try {
    transcriptItems = await fetchTranscript(url, { fetch: httpFetch as any })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/captcha|too many requests/i.test(msg)) {
      throw new Error(
        "YouTube 暂时拦截了当前 IP（需要验证码），无法直接抓取字幕。请切换出口节点/网络后重试，或等待 10-30 分钟再试。若你能在浏览器看到字幕，也可以先导出字幕文本再作为普通文件导入。",
      )
    }
    if (/transcript is disabled/i.test(msg)) {
      throw new Error(
        "该 YouTube 视频关闭了字幕功能（Transcript disabled），当前无法自动提取。可改为：1) 使用视频说明/评论区文本；2) 手动整理要点为笔记导入；3) 更换有字幕的镜像视频。",
      )
    }
    if (/no transcripts are available/i.test(msg)) {
      throw new Error(
        "该 YouTube 视频没有可用字幕轨道（No transcripts available），无法自动提取。建议手动整理内容后以 .md/.txt 文件导入。",
      )
    }
    if (isFetchNetworkError(err)) {
      throw new Error("拉取 YouTube 字幕失败：网络连接被拒绝（WebView 报错 Load failed）。请确认可访问 youtube.com 与 *.googlevideo.com，并关闭会拦截应用流量的代理规则。")
    }
    throw err
  }
  if (!Array.isArray(transcriptItems) || transcriptItems.length === 0) {
    throw new Error("未获取到 YouTube 字幕，可能该视频未提供字幕。")
  }

  const title = await fetchYouTubeTitle(url)
  const transcriptLines = transcriptItems
    .map((item: any) => {
      const start = typeof item?.offset === "number" ? item.offset : typeof item?.start === "number" ? item.start : 0
      const text = String(item?.text ?? "").replace(/\s+/g, " ").trim()
      if (!text) return null
      return `- [${secondsToTimestamp(start)}] ${text}`
    })
    .filter((line: string | null): line is string => !!line)

  if (transcriptLines.length === 0) {
    throw new Error("字幕内容为空，无法保存。")
  }
  const risks = detectPrivacyRisks(transcriptLines.join("\n"))
  if (risks.length > 0) {
    warnings.push(`YouTube 字幕中发现潜在敏感信息：${risks.join("、")}`)
  }

  const dir = `${projectPath}/raw/sources`
  const filePath = await uniquePath(dir, title, "md")
  const markdown =
    `---\n` +
    `type: video\n` +
    `platform: youtube\n` +
    `source_signal: extracted\n` +
    `title: "${title.replace(/"/g, '\\"')}"\n` +
    `url: "${url.replace(/"/g, '\\"')}"\n` +
    `captured: ${new Date().toISOString()}\n` +
    `---\n\n` +
    `# ${title}\n\n` +
    `Source: ${url}\n\n` +
    `## Transcript\n\n` +
    `${transcriptLines.join("\n")}\n`

  await writeFile(filePath, markdown)
  await maybeAnalyze(projectId, filePath, mode)
}

async function refreshTree(projectPath: string): Promise<void> {
  try {
    const tree = await listDirectory(projectPath)
    const store = useWikiStore.getState()
    store.setFileTree(tree)
    store.bumpDataVersion()
  } catch {
    // non-critical
  }
}

async function maybeAnalyze(projectId: string, sourcePath: string, mode: IngestMode): Promise<void> {
  if (mode !== "analyze") return
  if (!hasLlmConfigured()) {
    throw new Error("当前未配置可用 LLM，无法执行 Analyze。请先在设置中配置模型。")
  }
  await enqueueIngest(projectId, sourcePath)
}

async function saveNote(projectId: string, projectPath: string, payload: any, mode: IngestMode, warnings: string[]): Promise<void> {
  const content = String(payload?.content ?? "").trim()
  if (!content) throw new Error("笔记内容为空")
  const dir = `${projectPath}/raw/sources`
  const noteTitle = extractNoteTitle(content)
  const risks = detectPrivacyRisks(content)
  if (risks.length > 0) {
    warnings.push(`笔记中发现潜在敏感信息：${risks.join("、")}`)
  }
  const filePath = await uniquePath(dir, noteTitle, "md")
  const markdown =
    `---\n` +
    `type: note\n` +
    `created: ${new Date().toISOString()}\n` +
    `source_signal: direct_input\n` +
    `---\n\n${content}\n`
  await writeFile(filePath, markdown)
  await maybeAnalyze(projectId, filePath, mode)
}

async function saveLink(projectId: string, projectPath: string, payload: any, mode: IngestMode, warnings: string[]): Promise<void> {
  const url = String(payload?.url ?? "").trim()
  if (!url) throw new Error("链接不能为空")
  const platform = detectLinkPlatform(url)

  if (platform === "youtube") {
    await saveYouTubeLink(projectId, projectPath, url, mode, warnings)
    return
  }
  if (platform === "wechat") {
    throw new Error("微信抓取已移除，请使用 Obsidian Web Clipper 后导入文件。")
  }
  if (platform === "x") {
    throw new Error("X/Twitter 抓取器尚未接入。下一步可对接 x-to-markdown 能力。")
  }
  if (platform === "douyin_family") {
    throw new Error("抖音/TikTok/Bilibili 抓取器尚未接入。建议先配置外部 API 服务后对接。")
  }

  const httpFetch = await getHttpFetch()
  const response = await httpFetch(url, { method: "GET" })
  if (!response.ok) throw new Error(`抓取链接失败: HTTP ${response.status}`)
  const html = await response.text()
  const title = extractTitle(html, url)
  const text = htmlToText(html).slice(0, 20000)
  if (!text) throw new Error("链接内容为空，暂不支持该页面")
  const risks = detectPrivacyRisks(text)
  if (risks.length > 0) {
    warnings.push(`链接内容中发现潜在敏感信息：${risks.join("、")}`)
  }

  const dir = `${projectPath}/raw/sources`
  const filePath = await uniquePath(dir, title || "web-link", "md")
  const markdown =
    `---\n` +
    `type: link\n` +
    `source_signal: extracted\n` +
    `title: "${title.replace(/"/g, '\\"')}"\n` +
    `url: "${url.replace(/"/g, '\\"')}"\n` +
    `captured: ${new Date().toISOString()}\n` +
    `---\n\n` +
    `# ${title}\n\n` +
    `Source: ${url}\n\n` +
    `${text}\n`
  await writeFile(filePath, markdown)
  await maybeAnalyze(projectId, filePath, mode)
}

async function saveFile(projectId: string, projectPath: string, payload: any, mode: IngestMode): Promise<void> {
  const maybePath = typeof payload?.path === "string" ? payload.path : typeof payload?.file?.path === "string" ? payload.file.path : ""
  let sourcePath = maybePath
  if (!sourcePath) {
    const selected = await open({
      multiple: false,
      title: "选择要录入的文件",
      filters: [
        { name: "Documents", extensions: ["md", "mdx", "txt", "pdf", "docx", "pptx", "xlsx", "csv", "json", "html"] },
        { name: "All Files", extensions: ["*"] },
      ],
    })
    if (!selected || typeof selected !== "string") throw new Error("未选择文件")
    sourcePath = selected
  }
  const sourceName = getFileName(sourcePath) || "source"
  const dir = `${projectPath}/raw/sources`
  const ext = sourceName.includes(".") ? sourceName.slice(sourceName.lastIndexOf(".")) : ".txt"
  const stem = sourceName.replace(/\.[^.]+$/, "")
  const destPath = await uniquePath(dir, stem, ext)
  await copyFile(sourcePath, destPath)
  preprocessFile(destPath).catch(() => {})
  await maybeAnalyze(projectId, destPath, mode)
}

export async function runIngestEntry(ctx: IngestContext): Promise<IngestEntryResult> {
  const store = useWikiStore.getState()
  const project = store.project
  if (!project) throw new Error("当前没有打开项目")
  const projectPath = normalizePath(project.path)

  const warnings: string[] = []
  if (ctx.type === "note") {
    await saveNote(project.id, projectPath, ctx.payload, ctx.mode, warnings)
  } else if (ctx.type === "link") {
    await saveLink(project.id, projectPath, ctx.payload, ctx.mode, warnings)
  } else {
    await saveFile(project.id, projectPath, ctx.payload, ctx.mode)
  }

  await refreshTree(projectPath)
  return { warnings }
}
