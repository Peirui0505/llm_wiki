import { useRef, useState, useCallback, useMemo, useEffect } from "react"
import { ImagePlus, Send, Square, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { suggestSlashCommands } from "./slash-commands"

interface ChatInputProps {
  onSend: (text: string, images?: File[]) => void
  onStop: () => void
  isStreaming: boolean
  placeholder?: string
}

export function ChatInput({ onSend, onStop, isStreaming, placeholder }: ChatInputProps) {
  const [value, setValue] = useState("")
  const [activeIndex, setActiveIndex] = useState(0)
  const [images, setImages] = useState<File[]>([])
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const commands = useMemo(() => suggestSlashCommands(value), [value])
  const showSuggestions = !isStreaming && commands.length > 0

  useEffect(() => {
    setActiveIndex(0)
  }, [value])

  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value)
    const ta = e.target
    ta.style.height = "auto"
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`
  }, [])

  const handleSend = useCallback(() => {
    const trimmed = value.trim()
    if ((!trimmed && images.length === 0) || isStreaming) return
    onSend(trimmed, images)
    setValue("")
    setImages([])
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto"
    }
  }, [value, images, isStreaming, onSend])

  const appendImages = useCallback((newFiles: File[]) => {
    if (newFiles.length === 0) return
    setImages((prev) => [...prev, ...newFiles])
  }, [])

  const handleFilePick = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files || []).filter((f) => f.type.startsWith("image/"))
    appendImages(picked)
    e.target.value = ""
  }, [appendImages])

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const pastedImages = Array.from(e.clipboardData.items)
      .filter((item) => item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((f): f is File => Boolean(f))
    if (pastedImages.length > 0) {
      e.preventDefault()
      appendImages(pastedImages)
    }
  }, [appendImages])

  const applyCommand = useCallback((command: string, needsPayload: boolean | undefined) => {
    setValue(needsPayload ? `${command} ` : command)
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
      if (textareaRef.current) {
        const cursor = textareaRef.current.value.length
        textareaRef.current.setSelectionRange(cursor, cursor)
      }
    })
  }, [])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        if (showSuggestions) {
          e.preventDefault()
          const picked = commands[Math.max(0, Math.min(activeIndex, commands.length - 1))]
          if (picked) applyCommand(picked.command, picked.needsPayload)
          return
        }
        e.preventDefault()
        handleSend()
      } else if (showSuggestions && e.key === "ArrowDown") {
        e.preventDefault()
        setActiveIndex((prev) => (prev + 1) % commands.length)
      } else if (showSuggestions && e.key === "ArrowUp") {
        e.preventDefault()
        setActiveIndex((prev) => (prev - 1 + commands.length) % commands.length)
      } else if (showSuggestions && e.key === "Tab") {
        e.preventDefault()
        const picked = commands[Math.max(0, Math.min(activeIndex, commands.length - 1))]
        if (picked) applyCommand(picked.command, picked.needsPayload)
      }
    },
    [handleSend, showSuggestions, commands, activeIndex, applyCommand],
  )

  return (
    <div className="relative flex items-end gap-2 border-t p-3">
      <div className="relative flex-1">
        {showSuggestions && (
          <div className="absolute bottom-[calc(100%+8px)] left-0 z-20 w-full rounded-md border bg-popover p-1 shadow-md">
            {commands.map((item, idx) => (
              <button
                key={item.command}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault()
                  applyCommand(item.command, item.needsPayload)
                }}
                className={`flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm ${
                  idx === activeIndex ? "bg-accent text-accent-foreground" : "hover:bg-accent/70"
                }`}
              >
                <span className="font-mono">{item.command}</span>
                <span className="ml-2 text-xs text-muted-foreground">{item.description}</span>
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleInput}
          onPaste={handlePaste}
          onKeyDown={handleKeyDown}
          placeholder={placeholder ?? "Type a message... (Enter to send, Shift+Enter for newline)"}
          disabled={isStreaming}
          rows={1}
          className="w-full resize-none rounded-md border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          style={{ maxHeight: "120px", overflowY: "auto" }}
        />
        {images.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {images.map((file, idx) => (
              <span
                key={`${file.name}-${idx}`}
                className="inline-flex items-center gap-1 rounded-full border bg-muted px-2 py-0.5 text-xs"
              >
                <span className="max-w-[180px] truncate">{file.name}</span>
                <button
                  type="button"
                  onClick={() => {
                    setImages((prev) => prev.filter((_, i) => i !== idx))
                  }}
                  className="rounded p-0.5 hover:bg-accent"
                  title="移除图片"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={handleFilePick}
      />
      {!isStreaming && (
        <Button
          variant="outline"
          size="icon"
          onClick={() => imageInputRef.current?.click()}
          className="shrink-0"
          title="添加图片"
        >
          <ImagePlus className="h-4 w-4" />
        </Button>
      )}
      {isStreaming ? (
        <Button
          variant="destructive"
          size="icon"
          onClick={onStop}
          className="shrink-0"
          title="Stop generation"
        >
          <Square className="h-4 w-4" />
        </Button>
      ) : (
        <Button
          size="icon"
          onClick={handleSend}
          disabled={!value.trim() && images.length === 0}
          className="shrink-0"
          title="Send message"
        >
          <Send className="h-4 w-4" />
        </Button>
      )}
    </div>
  )
}
