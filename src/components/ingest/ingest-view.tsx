import { useState } from "react"
import { IngestEntry } from "@/components/ingest/ingest-entry"
import { runIngestEntry } from "@/lib/ingest-entry-service"

type IngestType = "link" | "file" | "note"

export function IngestView() {
  const [busy, setBusy] = useState(false)

  const handleAnalyze = async (type: IngestType, payload: any) => {
    setBusy(true)
    try {
      const result = await runIngestEntry({ type, payload, mode: "analyze" })
      const warn = result.warnings.length > 0 ? `\n\n隐私提醒：\n- ${result.warnings.join("\n- ")}` : ""
      window.alert(`已提交分析任务${warn}`)
    } catch (err) {
      window.alert(`分析失败: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const handleSave = async (type: IngestType, payload: any) => {
    setBusy(true)
    try {
      const result = await runIngestEntry({ type, payload, mode: "save" })
      const warn = result.warnings.length > 0 ? `\n\n隐私提醒：\n- ${result.warnings.join("\n- ")}` : ""
      window.alert(`已保存到原始资料${warn}`)
    } catch (err) {
      window.alert(`保存失败: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <IngestEntry onAnalyze={handleAnalyze} onSave={handleSave} busy={busy} />
    </div>
  )
}
