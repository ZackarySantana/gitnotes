import { SETTINGS_KEY, type Settings } from '../lib/types'

const tokenInput = document.getElementById('token') as HTMLInputElement
const saveButton = document.getElementById('save') as HTMLButtonElement
const statusLine = document.getElementById('status') as HTMLParagraphElement

let statusTimer: number | undefined

async function load(): Promise<void> {
  const raw = await chrome.storage.local.get(SETTINGS_KEY)
  const settings = (raw[SETTINGS_KEY] as Settings | undefined) ?? {}
  tokenInput.value = settings.githubToken ?? ''
}

async function save(): Promise<void> {
  const value = tokenInput.value.trim()
  const settings: Settings = { githubToken: value || undefined }
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings })
  statusLine.textContent = 'Saved.'
  if (statusTimer !== undefined) clearTimeout(statusTimer)
  statusTimer = setTimeout(() => {
    statusLine.textContent = ''
  }, 2000)
}

saveButton.addEventListener('click', () => void save())
tokenInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') void save()
})

void load()
