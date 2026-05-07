import { useState } from "react"
import { open } from "@tauri-apps/plugin-dialog"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { FolderOpen } from "lucide-react"
import { createProject, writeFile, createDirectory } from "@/commands/fs"
import { getTemplate } from "@/lib/templates"
import { TemplatePicker } from "@/components/project/template-picker"
import type { WikiProject } from "@/types/wiki"
import { normalizePath } from "@/lib/path-utils"

interface CreateProjectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (project: WikiProject) => void
}

export function CreateProjectDialog({ open: isOpen, onOpenChange, onCreated }: CreateProjectDialogProps) {
  const [name, setName] = useState("")
  const [path, setPath] = useState("")
  const [selectedTemplate, setSelectedTemplate] = useState("general")
  const [error, setError] = useState("")
  const [creating, setCreating] = useState(false)

  async function handleBrowse() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Select Parent Directory",
    })
    if (selected) {
      setPath(selected)
    }
  }

  async function handleCreate() {
    if (!name.trim() || !path.trim()) {
      setError("Name and path are required")
      return
    }
    setCreating(true)
    setError("")
    try {
      const project = await createProject(name.trim(), path.trim())
      const pp = normalizePath(project.path)

      const template = getTemplate(selectedTemplate)
      await writeFile(`${pp}/schema.md`, template.schema)
      await writeFile(`${pp}/purpose.md`, template.purpose)
      await writeFile(
        `${pp}/wiki/personal-growth/review-system.md`,
        [
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
        ].join("\n"),
      )
      await writeFile(
        `${pp}/wiki/personal-growth/review-commands.md`,
        [
          "# 复盘指令",
          "",
          "## 每日复盘",
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
          "",
          "## 每周复盘",
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
          "",
          "## 每月总结",
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
        ].join("\n"),
      )
      for (const dir of template.extraDirs) {
        await createDirectory(`${pp}/${dir}`)
      }

      onCreated(project)
      onOpenChange(false)
      setName("")
      setPath("")
      setSelectedTemplate("general")
    } catch (err) {
      setError(String(err))
    } finally {
      setCreating(false)
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Create New Wiki Project</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4 py-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="name">Project Name</Label>
            <Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="my-research-wiki" />
          </div>
          <div className="flex flex-col gap-2">
            <Label>Template</Label>
            <TemplatePicker selected={selectedTemplate} onSelect={setSelectedTemplate} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="path">Parent Directory</Label>
            <div className="flex gap-2">
              <Input id="path" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/Users/you/projects" className="flex-1" />
              <Button variant="outline" size="icon" onClick={handleBrowse} type="button">
                <FolderOpen className="h-4 w-4" />
              </Button>
            </div>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleCreate} disabled={creating}>{creating ? "Creating..." : "Create"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
