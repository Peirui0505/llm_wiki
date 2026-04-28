import { useWikiStore } from "@/stores/wiki-store"
import { detectLanguage } from "./detect-language"

function resolveLanguageMode(fallbackText: string = ""): {
  configured: string
  detected: string
  autoBilingual: boolean
  label: string
} {
  const configured = useWikiStore.getState().outputLanguage
  const detected = detectLanguage(fallbackText || "English")

  if (configured && configured !== "auto") {
    return {
      configured,
      detected,
      autoBilingual: false,
      label: configured,
    }
  }

  const isChineseInput = detected === "Chinese" || detected === "Traditional Chinese"
  if (isChineseInput) {
    return {
      configured: "auto",
      detected,
      autoBilingual: false,
      label: "Chinese",
    }
  }

  return {
    configured: "auto",
    detected,
    autoBilingual: true,
    label: `${detected} + Chinese`,
  }
}

/**
 * Get the effective output language for LLM content generation.
 *
 * If user has explicitly set an outputLanguage, use it.
 * Otherwise (auto), fall back to detecting the language from the given text.
 */
export function getOutputLanguage(fallbackText: string = ""): string {
  return resolveLanguageMode(fallbackText).label
}

/**
 * Build a strong language directive to inject into system prompts.
 */
export function buildLanguageDirective(fallbackText: string = ""): string {
  const mode = resolveLanguageMode(fallbackText)
  if (mode.autoBilingual) {
    return [
      `## ⚠️ MANDATORY OUTPUT LANGUAGES: ${mode.label}`,
      "",
      `You MUST write your response in **Chinese**, while preserving key terminology/examples from **${mode.detected}** when useful.`,
      `Use Chinese for structure, explanation, and conclusions; keep important source phrases in ${mode.detected} when precision matters.`,
      `Do NOT switch to any language outside ${mode.label}.`,
      `This overrides all other language instructions.`,
    ].join("\n")
  }

  const lang = mode.label
  return [
    `## ⚠️ MANDATORY OUTPUT LANGUAGE: ${lang}`,
    "",
    `You MUST write your entire response (including wiki page titles, content, descriptions, summaries, and any generated text) in **${lang}**.`,
    `The source material or wiki content may be in a different language, but this is IRRELEVANT to your output language.`,
    `Ignore the language of any source content. Generate everything in ${lang} only.`,
    `Proper nouns should use standard ${lang} transliteration when appropriate.`,
    `DO NOT use any other language. This overrides all other instructions.`,
  ].join("\n")
}

/**
 * Short reminder version — for placing right before user's current message.
 */
export function buildLanguageReminder(fallbackText: string = ""): string {
  const mode = resolveLanguageMode(fallbackText)
  if (mode.autoBilingual) {
    return `REMINDER: Respond in Chinese, and keep key terms/examples in ${mode.detected} when helpful. Use only ${mode.label}.`
  }
  return `REMINDER: All output must be in ${mode.label}. Do not use any other language.`
}
