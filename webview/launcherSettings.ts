// =============================================================================
// LauncherSettingsDialog — modal for editing the custom terminal launcher
// buttons (jamDesk.customLaunchers), split into Global (all projects) and
// Workspace (this project) sections. Each row is a { label, command } pair;
// Save sends both lists back to the host, which writes each to its config scope
// and echoes a settings update that rebuilds the toolbar buttons.
// =============================================================================

import type { LauncherButton } from './settings'
import { icons } from './icons'
import { t } from './i18n'

interface SaveScopes {
  global: LauncherButton[]
  workspace: LauncherButton[]
}

export class LauncherSettingsDialog {
  private backdrop: HTMLDivElement | null = null
  private globalList!: HTMLDivElement
  private workspaceList!: HTMLDivElement

  constructor(private onSave: (scopes: SaveScopes) => void) {}

  open(global: LauncherButton[], workspace: LauncherButton[]): void {
    if (this.backdrop) return // already open

    const backdrop = document.createElement('div')
    backdrop.className = 'dialog-backdrop'
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) this.close()
    })

    const panel = document.createElement('div')
    panel.className = 'dialog'

    const title = document.createElement('h2')
    title.className = 'dialog-title'
    title.textContent = t('launcherSettingsTitle')

    const hint = document.createElement('p')
    hint.className = 'dialog-hint'
    hint.textContent = t('launcherSettingsHint')

    this.globalList = document.createElement('div')
    this.workspaceList = document.createElement('div')
    const globalSection = this.section(t('launcherScopeGlobal'), this.globalList, global)
    const workspaceSection = this.section(t('launcherScopeWorkspace'), this.workspaceList, workspace)

    const footer = document.createElement('div')
    footer.className = 'dialog-footer'
    const cancel = document.createElement('button')
    cancel.className = 'dialog-btn'
    cancel.textContent = t('launcherCancel')
    cancel.addEventListener('click', () => this.close())
    const save = document.createElement('button')
    save.className = 'dialog-btn dialog-btn-primary'
    save.textContent = t('launcherSave')
    save.addEventListener('click', () => this.save())
    footer.append(cancel, save)

    panel.append(title, hint, globalSection, workspaceSection, footer)
    backdrop.appendChild(panel)
    document.body.appendChild(backdrop)
    this.backdrop = backdrop

    window.addEventListener('keydown', this.onKeydown)
    ;(panel.querySelector('input') as HTMLInputElement | null)?.focus()
  }

  /** A scope heading + its rows + an "add" button bound to that list. */
  private section(heading: string, list: HTMLDivElement, items: LauncherButton[]): HTMLDivElement {
    const wrap = document.createElement('div')
    wrap.className = 'launcher-section'

    const h = document.createElement('h3')
    h.className = 'launcher-scope-title'
    h.textContent = heading

    list.className = 'launcher-rows'
    for (const l of items) this.addRow(list, l)

    const add = document.createElement('button')
    add.className = 'dialog-add'
    add.innerHTML = `${icons.plus}<span>${t('launcherAdd')}</span>`
    add.addEventListener('click', () => {
      this.addRow(list, { label: '', command: '' })
      ;(list.lastElementChild?.querySelector('input') as HTMLInputElement | null)?.focus()
    })

    wrap.append(h, list, add)
    return wrap
  }

  private addRow(list: HTMLDivElement, l: LauncherButton): void {
    const row = document.createElement('div')
    row.className = 'launcher-row'

    const label = document.createElement('input')
    label.className = 'launcher-input launcher-input-label'
    label.placeholder = t('launcherLabelPlaceholder')
    label.value = l.label

    const command = document.createElement('input')
    command.className = 'launcher-input launcher-input-command'
    command.placeholder = t('launcherCommandPlaceholder')
    command.value = l.command

    const del = document.createElement('button')
    del.className = 'launcher-del'
    del.title = t('launcherDelete')
    del.setAttribute('aria-label', t('launcherDelete'))
    del.innerHTML = icons.trash
    del.addEventListener('click', () => row.remove())

    row.append(label, command, del)
    list.appendChild(row)
  }

  private collect(list: HTMLDivElement): LauncherButton[] {
    const out: LauncherButton[] = []
    for (const row of list.querySelectorAll('.launcher-row')) {
      const label = (row.querySelector('.launcher-input-label') as HTMLInputElement).value.trim()
      const command = (row.querySelector('.launcher-input-command') as HTMLInputElement).value.trim()
      // A button needs both a name and something to run.
      if (label && command) out.push({ label, command })
    }
    return out
  }

  private save(): void {
    this.onSave({
      global: this.collect(this.globalList),
      workspace: this.collect(this.workspaceList),
    })
    this.close()
  }

  private onKeydown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      this.close()
    }
  }

  close(): void {
    if (!this.backdrop) return
    window.removeEventListener('keydown', this.onKeydown)
    this.backdrop.remove()
    this.backdrop = null
  }
}
