import { describe, it, expect } from "vitest"
import { buildAnalysisPrompt, buildGenerationPrompt } from "./ingest"

describe("buildAnalysisPrompt language directive", () => {
  it("contains journal-first classification and planning rules", () => {
    const prompt = buildAnalysisPrompt("schema", "purpose", "index", "overview", "domain-indexes")
    expect(prompt).toContain("## STEP 1: Document Type Classification (MUST DO FIRST)")
    expect(prompt).toContain("### If JOURNAL:")
    expect(prompt).toContain("DO NOT plan any concept pages")
    expect(prompt).toContain("DO NOT plan any entity pages")
    expect(prompt).toContain("DOCUMENT_TYPE: [JOURNAL|ARTICLE|BOOK|CONVERSATION|OTHER]")
  })

  it("injects project context sections", () => {
    const prompt = buildAnalysisPrompt("my-schema", "my-purpose", "my-index", "my-overview", "my-domain-indexes")
    expect(prompt).toContain("### Purpose\nmy-purpose")
    expect(prompt).toContain("### Schema & Rules\nmy-schema")
    expect(prompt).toContain("### Current Index\nmy-index")
    expect(prompt).toContain("### Current Overview\nmy-overview")
    expect(prompt).toContain("### Domain Indexes (子目录结构参考，摄入时按此归类)\nmy-domain-indexes")
  })
})

describe("buildGenerationPrompt structure", () => {
  it("contains journal-only generation constraints", () => {
    const prompt = buildGenerationPrompt("schema", "analysis", "JOURNAL")
    expect(prompt).toContain("### For JOURNAL documents:")
    expect(prompt).toContain("DO NOT generate any concept or entity files")
    expect(prompt).toContain("Path: use the journal path from Schema Section 0 + journal-YYYY-MM-DD.md")
    expect(prompt).toContain("Schema Section 0 defines this as: wiki/personal-growth/journal/")
  })

  it("contains dedupe and log requirements", () => {
    const prompt = buildGenerationPrompt("schema", "analysis", "ARTICLE")
    expect(prompt).toContain("### Dedupe enforcement:")
    expect(prompt).toContain("Always append to wiki/log.md:")
    expect(prompt).toContain("## [YYYY-MM-DD] ingest | [brief description]")
  })

  it("injects schema, analysis and document type", () => {
    const prompt = buildGenerationPrompt("my-schema", "my-analysis", "BOOK")
    expect(prompt).toContain("## Schema Rules\nmy-schema")
    expect(prompt).toContain("## Analysis Results\nmy-analysis")
    expect(prompt).toContain("Detected Document Type: BOOK")
  })
})

describe("analysis + generation prompt consistency", () => {
  it("analysis outputs planning sections and generation enforces file-block output", () => {
    const analysis = buildAnalysisPrompt("", "", "", "", "")
    const generation = buildGenerationPrompt("", "", "OTHER")
    expect(analysis).toContain("FILES_TO_CREATE:")
    expect(analysis).toContain("DEDUPE_DECISIONS:")
    expect(generation).toContain("---FILE: wiki/path/to/file.md---")
    expect(generation).toContain("---END FILE---")
  })
})
