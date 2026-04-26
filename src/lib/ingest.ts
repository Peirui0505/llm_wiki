import { readFile, writeFile, listDirectory } from "@/commands/fs"
import { streamChat } from "@/lib/llm-client"
import type { LlmConfig } from "@/stores/wiki-store"
import { useWikiStore } from "@/stores/wiki-store"
import { useChatStore } from "@/stores/chat-store"
import { useActivityStore } from "@/stores/activity-store"
import { useReviewStore, type ReviewItem } from "@/stores/review-store"
import { getFileName, normalizePath } from "@/lib/path-utils"
import { checkIngestCache, saveIngestCache } from "@/lib/ingest-cache"
import { buildLanguageDirective } from "@/lib/output-language"
import { detectLanguage } from "@/lib/detect-language"

// Legacy export kept for backward compatibility with existing diagnostic
// tests. The live pipeline goes through parseFileBlocks() below, which
// handles classes of LLM output this regex silently drops (see H1/H3/H5
// in src/lib/ingest-parse.test.ts).
export const FILE_BLOCK_REGEX = /---FILE:\s*([^\n]+?)\s*---\n([\s\S]*?)---END FILE---/g

/** One FILE block extracted from an LLM's stage-2 output. */
export interface ParsedFileBlock {
  path: string
  content: string
}

/** What the parser produced, with any non-fatal issues surfaced. */
export interface ParseFileBlocksResult {
  blocks: ParsedFileBlock[]
  /** Human-readable notes for blocks we refused or couldn't close. Each
   *  one is also console.warn'd. UI can surface these so users see that
   *  something was skipped instead of silently getting fewer pages. */
  warnings: string[]
}

// Line-level openers / closers. Both are case-insensitive, tolerant of
// extra interior whitespace (`--- END FILE ---`), and anchored to the
// whole trimmed line so a stray `---END FILE---` inside prose or a list
// item (`- ---END FILE---`) won't register.
const OPENER_LINE = /^---\s*FILE:\s*(.+?)\s*---\s*$/i
const CLOSER_LINE = /^---\s*END\s+FILE\s*---\s*$/i
// Fence delimiters per CommonMark (triple+ backticks or tildes). Leading
// indentation ≤ 3 spaces is still a fence; 4+ spaces is an indented code
// block and doesn't use fence markers.
const FENCE_LINE = /^\s{0,3}(```+|~~~+)/

/**
 * Parse an LLM stage-2 generation into FILE blocks.
 *
 * Known hazards the naive `---FILE:...---END FILE---` regex walks into
 * (all reproduced as fixtures in src/lib/ingest-parse.test.ts):
 *
 *   H1. Windows CRLF line endings — regex anchored on bare `\n` missed
 *       every block.
 *   H2. Stream truncation — the last block's closing `---END FILE---`
 *       never arrived; the entire block was silently dropped with no
 *       logging.
 *   H3. Marker whitespace / case variants — `--- END FILE ---`,
 *       `---end file---`, `--- FILE: path ---`, `---FILE: foo--- \n`
 *       (trailing space) all made the regex fail.
 *   H5. Literal `---END FILE---` inside a fenced code block (e.g. when
 *       the LLM is writing a concept page about our own ingest format)
 *       — lazy match stopped at the first occurrence, truncating the
 *       page and dumping all subsequent real content into no-man's-land.
 *   H6. Empty path — block matched but was silently dropped by a
 *       downstream `!path` check.
 *
 * This parser fixes every one except H2 (which is fundamentally a
 * stream-budget problem), and at least surfaces H2 as a warning so the
 * user isn't left wondering why a page is missing.
 */
export function parseFileBlocks(text: string): ParseFileBlocksResult {
  // H1 fix: normalize CRLF to LF before anything else. Cheap and
  // covers the case where a proxy / server / LLM inserts Windows line
  // endings into the stream.
  const normalized = text.replace(/\r\n/g, "\n")
  const lines = normalized.split("\n")

  const blocks: ParsedFileBlock[] = []
  const warnings: string[] = []

  let i = 0
  while (i < lines.length) {
    const openerMatch = OPENER_LINE.exec(lines[i])
    if (!openerMatch) {
      i++
      continue
    }
    const path = openerMatch[1].trim()
    i++ // consume opener

    const contentLines: string[] = []
    let fenceMarker: string | null = null // tracks whether we're inside ``` or ~~~
    let fenceLen = 0
    let closed = false

    while (i < lines.length) {
      const line = lines[i]

      // H5 fix: update fence state before checking closer. Only close
      // the fence when we see the same character repeated at least as
      // many times — CommonMark rule. This lets docs-about-our-format
      // quote `---END FILE---` inside code fences without truncating
      // the outer block.
      const fenceMatch = FENCE_LINE.exec(line)
      if (fenceMatch) {
        const run = fenceMatch[1]
        const char = run[0] // '`' or '~'
        const len = run.length
        if (fenceMarker === null) {
          fenceMarker = char
          fenceLen = len
        } else if (char === fenceMarker && len >= fenceLen) {
          fenceMarker = null
          fenceLen = 0
        }
        contentLines.push(line)
        i++
        continue
      }

      // A line matching the closer ONLY counts when we're outside any
      // code fence. Inside a fence, treat it as ordinary body text.
      if (fenceMarker === null && CLOSER_LINE.test(line)) {
        closed = true
        i++
        break
      }

      contentLines.push(line)
      i++
    }

    if (!closed) {
      // H2 fix (partial): we can't fabricate content the LLM never
      // sent, but we surface the drop instead of silently hiding it.
      const pathLabel = path || "(unnamed)"
      const msg = `FILE block "${pathLabel}" was not closed before end of stream — likely truncation (model hit max_tokens, timeout, or connection dropped). Block dropped.`
      console.warn(`[ingest] ${msg}`)
      warnings.push(msg)
      continue
    }

    if (!path) {
      // H6 fix: surface empty-path blocks.
      const msg = `FILE block with empty path skipped (LLM omitted the path after \`---FILE:\`).`
      console.warn(`[ingest] ${msg}`)
      warnings.push(msg)
      continue
    }

    blocks.push({ path, content: contentLines.join("\n") })
  }

  return { blocks, warnings }
}

/**
 * Build the language rule for ingest prompts.
 * Uses the user's configured output language, falling back to source content detection.
 */
export function languageRule(sourceContent: string = ""): string {
  return buildLanguageDirective(sourceContent)
}

/**
 * Auto-ingest: reads source → LLM analyzes → LLM writes wiki pages, all in one go.
 * Used when importing new files.
 */
export async function autoIngest(
  projectPath: string,
  sourcePath: string,
  llmConfig: LlmConfig,
  signal?: AbortSignal,
  folderContext?: string,
): Promise<string[]> {
  const pp = normalizePath(projectPath)
  const sp = normalizePath(sourcePath)
  const activity = useActivityStore.getState()
  const fileName = getFileName(sp)
  const activityId = activity.addItem({
    type: "ingest",
    title: fileName,
    status: "running",
    detail: "Reading source...",
    filesWritten: [],
  })

  const [sourceContent, schema, purpose, index, overview] = await Promise.all([
    tryReadFile(sp),
    tryReadFile(`${pp}/schema.md`),
    tryReadFile(`${pp}/purpose.md`),
    tryReadFile(`${pp}/wiki/index.md`),
    tryReadFile(`${pp}/wiki/overview.md`),
  ])

  // ── Cache check: skip re-ingest if source content hasn't changed ──
  const cachedFiles = await checkIngestCache(pp, fileName, sourceContent)
  if (cachedFiles !== null) {
    activity.updateItem(activityId, {
      status: "done",
      detail: `Skipped (unchanged) — ${cachedFiles.length} files from previous ingest`,
      filesWritten: cachedFiles,
    })
    return cachedFiles
  }

  const truncatedContent = sourceContent.length > 50000
    ? sourceContent.slice(0, 50000) + "\n\n[...truncated...]"
    : sourceContent

  // ── Step 1: Analysis ──────────────────────────────────────────
  // LLM reads the source and produces a structured analysis:
  // key entities, concepts, main arguments, connections to existing wiki, contradictions
  activity.updateItem(activityId, { detail: "Step 1/2: Analyzing source..." })

  let analysis = ""

  await streamChat(
    llmConfig,
    [
      { role: "system", content: buildAnalysisPrompt(schema, purpose, index, overview) },
      { role: "user", content: `Analyze this source document:\n\n**File:** ${fileName}${folderContext ? `\n**Folder context:** ${folderContext}` : ""}\n\n---\n\n${truncatedContent}` },
    ],
    {
      onToken: (token) => { analysis += token },
      onDone: () => {},
      onError: (err) => {
        activity.updateItem(activityId, { status: "error", detail: `Analysis failed: ${err.message}` })
      },
    },
    signal,
    { temperature: 0.1 },
  )

  // A silent `return []` here would look like success to the queue
  // runner and cause the task to be filter()'d out. Throw instead so
  // processNext's catch-block path (retry / mark failed) engages.
  const analysisActivity = useActivityStore.getState().items.find((i) => i.id === activityId)
  if (analysisActivity?.status === "error") {
    throw new Error(analysisActivity.detail || "Analysis stream failed")
  }

  // Extract document type from stage-1 analysis.
  const documentType = analysis.includes("DOCUMENT_TYPE: JOURNAL")
    ? "JOURNAL"
    : "OTHER"

  // ── Step 2: Generation ────────────────────────────────────────
  // LLM takes the analysis as context and produces wiki files + review items
  activity.updateItem(activityId, { detail: "Step 2/2: Generating wiki pages..." })

  let generation = ""

  await streamChat(
    llmConfig,
    [
      { role: "system", content: buildGenerationPrompt(schema, analysis, documentType) },
      {
        role: "user",
        content: [
          `Source document to process: **${fileName}**`,
          "",
          "The Stage 1 analysis below is CONTEXT to inform your output. Do NOT echo",
          "its tables, bullet points, or prose. Your output must be FILE/REVIEW",
          "blocks as specified in the system prompt — nothing else.",
          "",
          "## Stage 1 Analysis (context only — do not repeat)",
          "",
          analysis,
          "",
          "## Original Source Content",
          "",
          truncatedContent,
          "",
          "---",
          "",
          `Now emit the FILE blocks for the wiki files derived from **${fileName}**.`,
          "Your response MUST begin with `---FILE:` as the very first characters.",
          "No preamble. No analysis prose. Start immediately.",
        ].join("\n"),
      },
    ],
    {
      onToken: (token) => { generation += token },
      onDone: () => {},
      onError: (err) => {
        activity.updateItem(activityId, { status: "error", detail: `Generation failed: ${err.message}` })
      },
    },
    signal,
    { temperature: 0.1 },
  )

  const generationActivity = useActivityStore.getState().items.find((i) => i.id === activityId)
  if (generationActivity?.status === "error") {
    throw new Error(generationActivity.detail || "Generation stream failed")
  }

  // ── Step 3: Write files ───────────────────────────────────────
  activity.updateItem(activityId, { detail: "Writing files..." })
  const { writtenPaths, warnings: writeWarnings } = await writeFileBlocks(pp, generation)

  // Surface parser / writer warnings to the activity panel so users
  // don't have to open devtools to find out a block was dropped.
  // Keeping the base "Writing files..." detail on top and appending the
  // first few warnings; full list stays in the console.
  if (writeWarnings.length > 0) {
    const summary = writeWarnings.length === 1
      ? writeWarnings[0]
      : `${writeWarnings.length} ingest warnings: ${writeWarnings.slice(0, 2).join(" · ")}${writeWarnings.length > 2 ? ` … (+${writeWarnings.length - 2} more in console)` : ""}`
    activity.updateItem(activityId, { detail: summary })
  }

  // Ensure source summary page exists (LLM may not have generated it correctly)
  const sourceBaseName = fileName.replace(/\.[^.]+$/, "")
  const sourceSummaryPath = `wiki/sources/${sourceBaseName}.md`
  const sourceSummaryFullPath = `${pp}/${sourceSummaryPath}`
  const hasSourceSummary = writtenPaths.some((p) => p.startsWith("wiki/sources/"))

  // If the signal was aborted (e.g. user switched projects / cancelled),
  // skip the fallback summary write — the LLM streams returned empty
  // via the abort fast-path (onDone), and writing a stub file into the
  // old project's wiki would both be noise and mask the error.
  // Returning no files lets processNext's length-0 safety net mark the
  // task for retry rather than "success".
  if (!hasSourceSummary && !signal?.aborted) {
    const date = new Date().toISOString().slice(0, 10)
    const fallbackContent = [
      "---",
      `type: source`,
      `title: "Source: ${fileName}"`,
      `created: ${date}`,
      `updated: ${date}`,
      `sources: ["${fileName}"]`,
      `tags: []`,
      `related: []`,
      "---",
      "",
      `# Source: ${fileName}`,
      "",
      analysis ? analysis.slice(0, 3000) : "(Analysis not available)",
      "",
    ].join("\n")
    try {
      await writeFile(sourceSummaryFullPath, fallbackContent)
      writtenPaths.push(sourceSummaryPath)
    } catch {
      // non-critical
    }
  }

  if (writtenPaths.length > 0) {
    try {
      const tree = await listDirectory(pp)
      useWikiStore.getState().setFileTree(tree)
      useWikiStore.getState().bumpDataVersion()
    } catch {
      // ignore
    }
  }

  // ── Step 4: Parse review items ────────────────────────────────
  const reviewItems = parseReviewBlocks(generation, sp)
  if (reviewItems.length > 0) {
    useReviewStore.getState().addItems(reviewItems)
  }

  // ── Step 5: Save to cache ───────────────────────────────────
  if (writtenPaths.length > 0) {
    await saveIngestCache(pp, fileName, sourceContent, writtenPaths)
  }

  // ── Step 6: Generate embeddings (if enabled) ───────────────
  const embCfg = useWikiStore.getState().embeddingConfig
  if (embCfg.enabled && embCfg.model && writtenPaths.length > 0) {
    try {
      const { embedPage } = await import("@/lib/embedding")
      for (const wpath of writtenPaths) {
        const pageId = wpath.split("/").pop()?.replace(/\.md$/, "") ?? ""
        if (!pageId || ["index", "log", "overview"].includes(pageId)) continue
        try {
          const content = await readFile(`${pp}/${wpath}`)
          const titleMatch = content.match(/^---\n[\s\S]*?^title:\s*["']?(.+?)["']?\s*$/m)
          const title = titleMatch ? titleMatch[1].trim() : pageId
          await embedPage(pp, pageId, title, content, embCfg)
        } catch {
          // non-critical
        }
      }
    } catch {
      // embedding module not available
    }
  }

  const detail = writtenPaths.length > 0
    ? `${writtenPaths.length} files written${reviewItems.length > 0 ? `, ${reviewItems.length} review item(s)` : ""}`
    : "No files generated"

  activity.updateItem(activityId, {
    status: writtenPaths.length > 0 ? "done" : "error",
    detail,
    filesWritten: writtenPaths,
  })

  return writtenPaths
}

/**
 * Per-file language guard. Strips frontmatter + code/math blocks, runs
 * detectLanguage on the remainder, and returns whether the content is in
 * a language family compatible with the target. This catches cases where
 * the LLM follows the format spec but writes a single page in a wrong
 * language (observed ~once in 5 real-LLM runs on MiniMax-M2.7-highspeed).
 */
function contentMatchesTargetLanguage(content: string, target: string): boolean {
  // Strip frontmatter
  const fmEnd = content.indexOf("\n---\n", 3)
  let body = fmEnd > 0 ? content.slice(fmEnd + 5) : content
  // Strip code + math
  body = body
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\$\$[\s\S]*?\$\$/g, "")
    .replace(/\$[^$\n]*\$/g, "")
  const sample = body.slice(0, 1500)
  if (sample.trim().length < 20) return true // too short to judge

  const detected = detectLanguage(sample)

  // Compatible families: CJK targets accept CJK variants; Latin targets
  // accept any Latin family (English may mis-detect as Italian/French for
  // short idiomatic samples — that's fine). Cross-family is the real bug.
  const cjk = new Set(["Chinese", "Traditional Chinese", "Japanese", "Korean"])
  const targetIsCjk = cjk.has(target)
  const detectedIsCjk = cjk.has(detected)
  if (targetIsCjk) return detectedIsCjk
  return !detectedIsCjk && !["Arabic", "Hindi", "Thai", "Hebrew"].includes(detected)
}

async function writeFileBlocks(
  projectPath: string,
  text: string,
): Promise<{ writtenPaths: string[]; warnings: string[] }> {
  const { blocks, warnings: parseWarnings } = parseFileBlocks(text)
  const warnings = [...parseWarnings]
  const writtenPaths: string[] = []
  const dirMdCache = new Map<string, string[]>()

  const targetLang = useWikiStore.getState().outputLanguage

  for (const { path: relativePath, content } of blocks) {
    let targetPath = relativePath
    let targetContent = content

    // Language guard: reject individual FILE blocks whose body contradicts
    // the user-set target language. Skip:
    // - log.md (structural, short)
    // - /sources/ and /entities/ pages: these legitimately cite cross-
    //   language proper nouns (a German philosophy source summary naturally
    //   quotes Russian philosophers) which confuses naive script-based
    //   detection. Keep the check for /concepts/ pages, which should be
    //   authoritative content in the target language.
    const isLog =
      targetPath.endsWith("/log.md") || targetPath === "wiki/log.md"
    const isEntityOrSource =
      targetPath.startsWith("wiki/entities/") ||
      targetPath.includes("/entities/") ||
      targetPath.startsWith("wiki/sources/") ||
      targetPath.includes("/sources/")
    if (
      targetLang &&
      targetLang !== "auto" &&
      !isLog &&
      !isEntityOrSource &&
      !contentMatchesTargetLanguage(targetContent, targetLang)
    ) {
      const msg = `Dropped "${targetPath}" — body language doesn't match target ${targetLang}.`
      console.warn(`[ingest] ${msg}`)
      warnings.push(msg)
      continue
    }

    const isEntityOrConceptPath =
      (targetPath.startsWith("wiki/entities/") || targetPath.includes("/entities/") ||
        targetPath.startsWith("wiki/concepts/") || targetPath.includes("/concepts/")) &&
      targetPath.endsWith(".md")

    // Dedupe entity/concept pages by normalized title/frontmatter key.
    // This avoids creating near-duplicate pages such as:
    // - "雅思考试" vs "雅思考试（IELTS）"
    // - "我（作者）" vs "我（日记作者）"
    if (isEntityOrConceptPath) {
      const incomingKey = deriveDedupeKey(targetPath, targetContent)
      const dir = targetPath.slice(0, targetPath.lastIndexOf("/"))
      if (!dirMdCache.has(dir)) {
        try {
          const tree = await listDirectory(`${projectPath}/${dir}`)
          dirMdCache.set(dir, flattenMdPaths(tree))
        } catch {
          dirMdCache.set(dir, [])
        }
      }
      const existingInDir = (dirMdCache.get(dir) ?? []).filter((p) => !p.endsWith(`/${getFileName(targetPath)}`))
      let matchedPath: string | null = null
      for (const fullExisting of existingInDir) {
        const relExisting = fullExisting.startsWith(`${projectPath}/`)
          ? fullExisting.slice(projectPath.length + 1)
          : fullExisting
        const existingContent = await tryReadFile(fullExisting)
        if (!existingContent) continue
        const existingKey = deriveDedupeKey(relExisting, existingContent)
        if (existingKey && incomingKey && existingKey === incomingKey) {
          matchedPath = relExisting
          break
        }
      }
      if (matchedPath && matchedPath !== targetPath) {
        const oldPath = targetPath
        targetPath = matchedPath
        targetContent = withDedupeMetadata(targetContent, incomingKey, "dedupe: update_existing_entity_or_concept")
        warnings.push(`Dedupe matched "${oldPath}" -> "${matchedPath}" (key: ${incomingKey})`)
      } else if (incomingKey) {
        targetContent = withDedupeMetadata(targetContent, incomingKey, "dedupe: create_new_entity_or_concept")
      }
    }

    const fullPath = `${projectPath}/${targetPath}`
    try {
      if (targetPath === "wiki/log.md" || targetPath.endsWith("/log.md")) {
        const existing = await tryReadFile(fullPath)
        const appended = existing ? `${existing}\n\n${targetContent.trim()}` : targetContent.trim()
        await writeFile(fullPath, appended)
      } else if (
        targetPath === "wiki/index.md" ||
        targetPath.endsWith("/index.md") ||
        targetPath === "wiki/overview.md" ||
        targetPath.endsWith("/overview.md")
      ) {
        // Listing pages (index / overview) are always overwritten
        // wholesale — their sources field is incidental and merging
        // wouldn't make semantic sense (they aren't source-derived
        // content pages).
        await writeFile(fullPath, targetContent)
      } else {
        // Content pages (entities / concepts / queries / synthesis /
        // comparisons / sources summaries): MERGE the sources field
        // with what's already on disk before overwriting, so pages
        // that multiple source documents contribute to retain the
        // full `sources: [...]` history. Without this, every
        // re-ingest clobbers sources to a single entry and the
        // source-delete flow would later treat the page as single-
        // sourced and delete it outright — silent data loss.
        //
        // See src/lib/sources-merge.ts for the merge semantics
        // (case-insensitive dedup, preserves existing order).
        const { mergeSourcesIntoContent } = await import("./sources-merge")
        const existing = await tryReadFile(fullPath)
        const toWrite = mergeSourcesIntoContent(targetContent, existing)
        await writeFile(fullPath, toWrite)
      }
      writtenPaths.push(targetPath)
    } catch (err) {
      const msg = `Failed to write "${targetPath}": ${err instanceof Error ? err.message : String(err)}`
      console.error(`[ingest] ${msg}`)
      warnings.push(msg)
    }
  }

  return { writtenPaths, warnings }
}

const REVIEW_BLOCK_REGEX = /---REVIEW:\s*(\w[\w-]*)\s*\|\s*(.+?)\s*---\n([\s\S]*?)---END REVIEW---/g

function parseReviewBlocks(
  text: string,
  sourcePath: string,
): Omit<ReviewItem, "id" | "resolved" | "createdAt">[] {
  const items: Omit<ReviewItem, "id" | "resolved" | "createdAt">[] = []
  const matches = text.matchAll(REVIEW_BLOCK_REGEX)

  for (const match of matches) {
    const rawType = match[1].trim().toLowerCase()
    const title = match[2].trim()
    const body = match[3].trim()

    const type = (
      ["contradiction", "duplicate", "missing-page", "suggestion"].includes(rawType)
        ? rawType
        : "confirm"
    ) as ReviewItem["type"]

    // Parse OPTIONS line
    const optionsMatch = body.match(/^OPTIONS:\s*(.+)$/m)
    const options = optionsMatch
      ? optionsMatch[1].split("|").map((o) => {
          const label = o.trim()
          return { label, action: label }
        })
      : [
          { label: "Approve", action: "Approve" },
          { label: "Skip", action: "Skip" },
        ]

    // Parse PAGES line
    const pagesMatch = body.match(/^PAGES:\s*(.+)$/m)
    const affectedPages = pagesMatch
      ? pagesMatch[1].split(",").map((p) => p.trim())
      : undefined

    // Parse SEARCH line (optimized search queries for Deep Research)
    const searchMatch = body.match(/^SEARCH:\s*(.+)$/m)
    const searchQueries = searchMatch
      ? searchMatch[1].split("|").map((q) => q.trim()).filter((q) => q.length > 0)
      : undefined

    // Description is the body minus OPTIONS, PAGES, and SEARCH lines
    const description = body
      .replace(/^OPTIONS:.*$/m, "")
      .replace(/^PAGES:.*$/m, "")
      .replace(/^SEARCH:.*$/m, "")
      .trim()

    items.push({
      type,
      title,
      description,
      sourcePath,
      affectedPages,
      searchQueries,
      options,
    })
  }

  return items
}

/**
 * Step 1 prompt: AI reads the source and produces a structured analysis.
 * This is the "discussion" step — the AI reasons about the source before writing wiki pages.
 */
export function buildAnalysisPrompt(
  schema: string,
  purpose: string,
  index: string,
  overview: string,
): string {
  return `
You are a knowledge wiki assistant. Your job is to analyze a source document and plan what wiki pages to create or update.

## Project Context

### Purpose
${purpose}

### Schema & Rules
${schema}

### Current Index
${index}

### Current Overview
${overview}

## STEP 1: Document Type Classification (MUST DO FIRST)

Classify the input document into one of these types:
- JOURNAL: personal diary, daily review, 每日复盘, contains AMWAP/Worthy Memory/拟真日记
- ARTICLE: blog post, news, essay, tutorial
- BOOK: book notes, reading summary
- CONVERSATION: chat log, Q&A, AI conversation worth saving
- OTHER: anything else

## STEP 2: Plan based on document type

### If JOURNAL:
- Output plan: create ONE file at personal-growth/journal/journal-YYYY-MM-DD.md
- DO NOT plan any concept pages
- DO NOT plan any entity pages
- DO NOT extract people mentioned in diary as entities
- DO NOT extract emotions or personal events as concepts

### If ARTICLE / BOOK / OTHER:
- Plan a source summary page at wiki/sources/
- Check existing concepts and entities before planning new ones
- For each potential concept/entity, check if a similar page already exists
- If similar exists: plan to UPDATE existing page, not create new
- Use dedupe_key rule: lowercase title, remove punctuation, spaces to hyphens
- Only plan new concept/entity pages if genuinely new (different topic, not just different wording)

## STEP 3: Dedupe Check

Before finalizing your plan, list:
- Concepts you considered but decided to MERGE into existing pages (and which page)
- Entities you considered but decided to MERGE into existing pages (and which page)

## Output Format

Respond with a structured analysis:

DOCUMENT_TYPE: [JOURNAL|ARTICLE|BOOK|CONVERSATION|OTHER]
DOCUMENT_DATE: [YYYY-MM-DD if identifiable, else unknown]

FILES_TO_CREATE:
- [path]: [one line description]

FILES_TO_UPDATE:
- [path]: [what to add/change]

DEDUPE_DECISIONS:
- [concept/entity name] → merged into [existing page path]

REASONING: [2-3 sentences explaining your decisions]
`.trim()
}

/**
 * Step 2 prompt: AI takes its own analysis and generates wiki files + review items.
 */
export function buildGenerationPrompt(
  schema: string,
  analysis: string,
  documentType: string,
): string {
  return `
You are a knowledge wiki assistant. Based on the analysis below, generate the exact file contents.

## Schema Rules
${schema}

## Analysis Results
${analysis}

Detected Document Type: ${documentType}

## Generation Rules

### For JOURNAL documents:
Generate ONE file only:
- Path: personal-growth/journal/journal-YYYY-MM-DD.md
- Structure:
  Upper half: 📥 今日碎片 section (raw content preserved as-is)
  Lower half: 📅 每日复盘 section (empty template, to be filled later)
- Preserve the original diary content exactly, do not summarize or extract
- DO NOT generate any concept or entity files

### For all other documents:
- Follow schema frontmatter format (type/created/updated/status/source_signal/dedupe_key/dedupe_note/aliases)
- Every page must start with a bold one-line summary
- Tags go inline after the summary: #tag1 #tag2
- Sources and links go at the bottom of each page
- Use first-person authentic voice, no corporate tone
- Minimum 2 internal [[links]] per page

### Dedupe enforcement:
- If analysis says merge into existing page, output UPDATE instructions for that page only
- Never create a new page if analysis decided to merge

### Log entry:
Always append to wiki/log.md:
\`\`\`
## [YYYY-MM-DD] ingest | [brief description]
- 来源：[source]
- 新增页面：[list or none]
- 更新页面：[list or none]
- 核心贡献：[one sentence]
\`\`\`

## Output Format

Use this exact format for each file:

---FILE: wiki/path/to/file.md---
[file contents here]
---END FILE---

Generate all planned files now.
`.trim()
}

function getStore() {
  return useChatStore.getState()
}

async function tryReadFile(path: string): Promise<string> {
  try {
    return await readFile(path)
  } catch {
    return ""
  }
}

function extractFrontmatter(content: string): { body: string; frontmatter: string | null } {
  if (!content.startsWith("---\n")) return { body: content, frontmatter: null }
  const end = content.indexOf("\n---\n", 4)
  if (end < 0) return { body: content, frontmatter: null }
  return {
    frontmatter: content.slice(4, end),
    body: content.slice(end + 5),
  }
}

function getFrontmatterField(content: string, field: string): string {
  const { frontmatter } = extractFrontmatter(content)
  if (!frontmatter) return ""
  const re = new RegExp(`^${field}:\\s*["']?(.+?)["']?\\s*$`, "m")
  const m = frontmatter.match(re)
  return m?.[1]?.trim() ?? ""
}

function normalizeDedupeKey(raw: string): string {
  const noParenthetical = raw.replace(/[（(][^()（）]{1,80}[)）]/g, " ").trim()
  const base = noParenthetical || raw
  return base
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
}

function deriveDedupeKey(relativePath: string, content: string): string {
  const explicit = getFrontmatterField(content, "dedupe_key")
  if (explicit) return normalizeDedupeKey(explicit)
  const title = getFrontmatterField(content, "title")
  if (title) return normalizeDedupeKey(title)
  const stem = getFileName(relativePath).replace(/\.md$/i, "")
  return normalizeDedupeKey(stem)
}

function withDedupeMetadata(content: string, dedupeKey: string, dedupeNote: string): string {
  const { frontmatter, body } = extractFrontmatter(content)
  if (!frontmatter) {
    return [
      "---",
      `dedupe_key: "${dedupeKey}"`,
      `dedupe_note: "${dedupeNote.replace(/"/g, '\\"')}"`,
      "---",
      "",
      content,
    ].join("\n")
  }

  const lines = frontmatter.split("\n").filter((line) => !/^dedupe_key:/.test(line) && !/^dedupe_note:/.test(line))
  lines.push(`dedupe_key: "${dedupeKey}"`)
  lines.push(`dedupe_note: "${dedupeNote.replace(/"/g, '\\"')}"`)
  return `---\n${lines.join("\n")}\n---\n${body}`
}

function flattenMdPaths(nodes: Array<{ path: string; is_dir: boolean; children?: any[] }>): string[] {
  const out: string[] = []
  for (const n of nodes) {
    if (n.is_dir && n.children) out.push(...flattenMdPaths(n.children))
    else if (!n.is_dir && n.path.endsWith(".md")) out.push(n.path)
  }
  return out
}

export async function startIngest(
  projectPath: string,
  sourcePath: string,
  llmConfig: LlmConfig,
  signal?: AbortSignal,
): Promise<void> {
  const pp = normalizePath(projectPath)
  const sp = normalizePath(sourcePath)
  const store = getStore()
  store.setMode("ingest")
  store.setIngestSource(sp)
  store.clearMessages()
  store.setStreaming(false)

  const [sourceContent, schema, purpose, index] = await Promise.all([
    tryReadFile(sp),
    tryReadFile(`${pp}/wiki/schema.md`),
    tryReadFile(`${pp}/wiki/purpose.md`),
    tryReadFile(`${pp}/wiki/index.md`),
  ])

  const fileName = getFileName(sp)

  const systemPrompt = [
    "You are a knowledgeable assistant helping to build a wiki from source documents.",
    "",
    languageRule(sourceContent),
    "",
    purpose ? `## Wiki Purpose\n${purpose}` : "",
    schema ? `## Wiki Schema\n${schema}` : "",
    index ? `## Current Wiki Index\n${index}` : "",
  ]
    .filter(Boolean)
    .join("\n\n")

  const userMessage = [
    `I'm ingesting the following source file into my wiki: **${fileName}**`,
    "",
    "Please read it carefully and present the key takeaways, important concepts, and information that would be valuable to capture in the wiki. Highlight anything that relates to the wiki's purpose and schema.",
    "",
    "---",
    `**File: ${fileName}**`,
    "```",
    sourceContent || "(empty file)",
    "```",
  ].join("\n")

  store.addMessage("user", userMessage)
  store.setStreaming(true)

  let accumulated = ""

  await streamChat(
    llmConfig,
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    {
      onToken: (token) => {
        accumulated += token
        getStore().appendStreamToken(token)
      },
      onDone: () => {
        getStore().finalizeStream(accumulated)
      },
      onError: (err) => {
        getStore().finalizeStream(`Error during ingest: ${err.message}`)
      },
    },
    signal,
  )
}

export async function executeIngestWrites(
  projectPath: string,
  llmConfig: LlmConfig,
  userGuidance?: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const pp = normalizePath(projectPath)
  const store = getStore()

  const [schema, index] = await Promise.all([
    tryReadFile(`${pp}/wiki/schema.md`),
    tryReadFile(`${pp}/wiki/index.md`),
  ])

  const conversationHistory = store.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }))

  const writePrompt = [
    "Based on our discussion, please generate the wiki files that should be created or updated.",
    "",
    userGuidance ? `Additional guidance: ${userGuidance}` : "",
    "",
    schema ? `## Wiki Schema\n${schema}` : "",
    index ? `## Current Wiki Index\n${index}` : "",
    "",
    "Output ONLY the file contents in this exact format for each file:",
    "```",
    "---FILE: wiki/path/to/file.md---",
    "(file content here)",
    "---END FILE---",
    "```",
    "",
    "For wiki/log.md, include a log entry to append. For all other files, output the complete file content.",
    "Use relative paths from the project root (e.g., wiki/sources/topic.md).",
    "Do not include any other text outside the FILE blocks.",
  ]
    .filter((line) => line !== undefined)
    .join("\n")

  conversationHistory.push({ role: "user", content: writePrompt })

  store.addMessage("user", writePrompt)
  store.setStreaming(true)

  let accumulated = ""

  // In auto mode, fall back to detecting language from the chat history
  // (user's discussion messages) rather than the empty string, which would
  // default to English regardless of the source content.
  const historyText = conversationHistory
    .map((m) => m.content)
    .join("\n")
    .slice(0, 2000)

  const systemPrompt = [
    "You are a wiki generation assistant. Your task is to produce structured wiki file contents.",
    "",
    languageRule(historyText),
    schema ? `## Wiki Schema\n${schema}` : "",
  ]
    .filter(Boolean)
    .join("\n\n")

  await streamChat(
    llmConfig,
    [{ role: "system", content: systemPrompt }, ...conversationHistory],
    {
      onToken: (token) => {
        accumulated += token
        getStore().appendStreamToken(token)
      },
      onDone: () => {
        getStore().finalizeStream(accumulated)
      },
      onError: (err) => {
        getStore().finalizeStream(`Error generating wiki files: ${err.message}`)
      },
    },
    signal,
  )

  const writtenPaths: string[] = []
  const dedupeRecords: string[] = []
  const dirMdCache = new Map<string, string[]>()
  const matches = accumulated.matchAll(FILE_BLOCK_REGEX)

  for (const match of matches) {
    let relativePath = match[1].trim()
    let content = match[2]

    if (!relativePath) continue

    const isDedupeTarget =
      relativePath.startsWith("wiki/synthesis/") ||
      relativePath.startsWith("wiki/comparisons/")
    if (isDedupeTarget && relativePath.endsWith(".md")) {
      const incomingKey = deriveDedupeKey(relativePath, content)
      const dir = relativePath.slice(0, relativePath.lastIndexOf("/"))
      if (!dirMdCache.has(dir)) {
        try {
          const tree = await listDirectory(`${pp}/${dir}`)
          dirMdCache.set(dir, flattenMdPaths(tree))
        } catch {
          dirMdCache.set(dir, [])
        }
      }
      const existingInDir = (dirMdCache.get(dir) ?? []).filter((p) => !p.endsWith(`/${getFileName(relativePath)}`))
      let matchedPath: string | null = null
      for (const fullExisting of existingInDir) {
        const relExisting = fullExisting.startsWith(`${pp}/`) ? fullExisting.slice(pp.length + 1) : fullExisting
        const existingContent = await tryReadFile(fullExisting)
        if (!existingContent) continue
        const existingKey = deriveDedupeKey(relExisting, existingContent)
        if (existingKey && incomingKey && existingKey === incomingKey) {
          matchedPath = relExisting
          break
        }
      }

      if (matchedPath) {
        relativePath = matchedPath
        content = withDedupeMetadata(content, incomingKey, "dedupe: update_existing_page")
        dedupeRecords.push(`- ${incomingKey}: update -> ${matchedPath}`)
      } else {
        content = withDedupeMetadata(content, incomingKey, "dedupe: create_new_page")
        dedupeRecords.push(`- ${incomingKey}: create -> ${relativePath}`)
      }
    }

    const fullPath = `${pp}/${relativePath}`

    try {
      if (relativePath === "wiki/log.md" || relativePath.endsWith("/log.md")) {
        const existing = await tryReadFile(fullPath)
        const appended = existing
          ? `${existing}\n\n${content.trim()}`
          : content.trim()
        await writeFile(fullPath, appended)
      } else {
        await writeFile(fullPath, content)
      }
      writtenPaths.push(fullPath)
    } catch (err) {
      console.error(`Failed to write ${fullPath}:`, err)
    }
  }

  if (writtenPaths.length > 0) {
    const fileList = writtenPaths.map((p) => `- ${p}`).join("\n")
    const dedupeInfo = dedupeRecords.length > 0
      ? `\n\nDedupe records:\n${dedupeRecords.join("\n")}`
      : ""
    getStore().addMessage("system", `Files written to wiki:\n${fileList}${dedupeInfo}`)
  } else {
    getStore().addMessage("system", "No files were written. The LLM response did not contain valid FILE blocks.")
  }

  return writtenPaths
}
