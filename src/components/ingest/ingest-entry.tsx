import { useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from "react"
import { Upload } from "lucide-react"

type IngestType = "link" | "file" | "note"

export interface IngestEntryProps {
  onAnalyze: (type: IngestType, payload: any) => void
  onSave: (type: IngestType, payload: any) => void
  busy?: boolean
}

const TABS: Array<{ key: IngestType; label: string }> = [
  { key: "link", label: "链接" },
  { key: "file", label: "文件" },
  { key: "note", label: "笔记" },
]

export function IngestEntry({ onAnalyze, onSave, busy = false }: IngestEntryProps) {
  const [activeTab, setActiveTab] = useState<IngestType>("link")
  const [linkValue, setLinkValue] = useState("")
  const [noteValue, setNoteValue] = useState("")
  const [fileValue, setFileValue] = useState<File | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const noteRef = useRef<HTMLTextAreaElement>(null)

  const payload = useMemo(() => {
    if (activeTab === "link") return { url: linkValue.trim() }
    if (activeTab === "file") return { file: fileValue }
    return { content: noteValue.trim() }
  }, [activeTab, fileValue, linkValue, noteValue])

  const handleChooseFile = () => {
    fileInputRef.current?.click()
  }

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null
    setFileValue(file)
  }

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setIsDragOver(false)
    const file = event.dataTransfer.files?.[0] ?? null
    if (file) setFileValue(file)
  }

  useEffect(() => {
    if (activeTab !== "note" || !noteRef.current) return
    noteRef.current.style.height = "auto"
    noteRef.current.style.height = `${Math.max(noteRef.current.scrollHeight, 120)}px`
  }, [activeTab, noteValue])

  return (
    <div className="mx-auto w-full max-w-3xl p-6">
      <div className="space-y-6">
        <div className="relative border-b border-zinc-200">
          <div className="flex items-center gap-8">
            {TABS.map((tab) => {
              const isActive = activeTab === tab.key
              return (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => setActiveTab(tab.key)}
                  className={`pb-3 text-sm transition-colors ${
                    isActive ? "font-semibold text-black" : "font-normal text-zinc-400 hover:text-zinc-700"
                  }`}
                >
                  {tab.label}
                </button>
              )
            })}
          </div>
          <div
            className="absolute bottom-0 h-0.5 bg-black transition-all duration-200"
            style={{
              width: "28px",
              left: activeTab === "link" ? "0px" : activeTab === "file" ? "60px" : "120px",
            }}
          />
        </div>

        <div className="space-y-4">
          {activeTab === "link" && (
            <div className="space-y-2">
              <input
                type="url"
                value={linkValue}
                onChange={(event) => setLinkValue(event.target.value)}
                placeholder="粘贴链接"
                className="w-full border-0 border-b border-zinc-200 bg-transparent pb-3 text-sm text-black outline-none placeholder:text-zinc-400 focus:border-zinc-300"
              />
              <p className="text-xs text-zinc-400">
                支持网页、YouTube、微信公众号、抖音、小红书、X链接自动提取
              </p>
            </div>
          )}

          {activeTab === "file" && (
            <div
              role="button"
              tabIndex={0}
              onClick={handleChooseFile}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault()
                  handleChooseFile()
                }
              }}
              onDragOver={(event) => {
                event.preventDefault()
                setIsDragOver(true)
              }}
              onDragLeave={() => setIsDragOver(false)}
              onDrop={handleDrop}
              className={`flex min-h-[220px] cursor-pointer flex-col items-center justify-center rounded-md border border-dashed px-6 py-12 text-center transition-colors ${
                isDragOver ? "border-zinc-400" : "border-zinc-300"
              }`}
            >
              <Upload className="h-8 w-8 stroke-[1.5] text-zinc-500" />
              <p className="mt-4 text-sm text-black">{fileValue?.name ?? "上传文件"}</p>
              <p className="mt-1 text-xs text-zinc-400">PDF、Markdown、文本</p>
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.md,.markdown,.txt"
                onChange={handleFileChange}
                className="hidden"
              />
            </div>
          )}

          {activeTab === "note" && (
            <textarea
              ref={noteRef}
              value={noteValue}
              onChange={(event) => setNoteValue(event.target.value)}
              placeholder="输入笔记或灵感..."
              rows={4}
              className="min-h-[120px] w-full resize-none border-0 bg-transparent text-sm leading-6 text-black outline-none placeholder:text-zinc-400"
            />
          )}
        </div>

        <div className="flex items-center justify-end gap-4 pt-2">
          <button
            type="button"
            onClick={() => onAnalyze(activeTab, payload)}
            disabled={busy}
            className="rounded-md bg-black px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? "处理中..." : "分析"}
          </button>
          <button
            type="button"
            onClick={() => onSave(activeTab, payload)}
            disabled={busy}
            className="text-sm text-zinc-500 transition-colors hover:text-zinc-800 disabled:cursor-not-allowed disabled:text-zinc-400"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
