import { Sparkles } from 'lucide-react'
import { MCPStatus } from '@/components/addons/MCPStatus'
import { CredsInventory } from '@/components/addons/CredsInventory'
import { QuickCmds } from '@/components/addons/QuickCmds'
import { SshInventory } from '@/components/addons/SshInventory'
import { VpsMonitor } from '@/components/addons/VpsMonitor'

export function ExtrasPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Sparkles className="w-6 h-6 text-muted-foreground" />
        <h1 className="text-2xl font-semibold tracking-tight">Extras</h1>
        <span className="ml-auto text-sm text-muted-foreground">VPS · MCP · Credenziali · SSH</span>
      </div>

      <VpsMonitor />

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <MCPStatus />
        <QuickCmds />
        <CredsInventory />
        <SshInventory />
      </div>
    </div>
  )
}
