import fs from 'node:fs/promises'
import path from 'node:path'

export class ConversationStore {
  constructor(filePath = '') {
    this.byChatId = new Map()
    this.filePath = filePath
    this.saveTimer = null
  }

  async load() {
    if (!this.filePath) return

    try {
      const raw = await fs.readFile(this.filePath, 'utf8')
      const data = JSON.parse(raw)
      this.byChatId = new Map(Object.entries(data || {}).map(([chatId, state]) => [chatId, normalizeState(state)]))
    } catch {
      this.byChatId = new Map()
    }
  }

  get(chatId) {
    if (!this.byChatId.has(chatId)) {
      this.byChatId.set(chatId, normalizeState({}))
    }
    return this.byChatId.get(chatId)
  }

  add(chatId, role, text) {
    const state = this.get(chatId)
    state.messages.push({ role, text, at: Date.now() })
    state.messages = state.messages.slice(-12)
    this.scheduleSave()
    return state
  }

  setLastOrder(chatId, orderId) {
    const state = this.get(chatId)
    state.lastOrderId = orderId
    state.pendingOrder = null
    state.awaitingPaymentProof = null
    state.orderDraft = null
    this.scheduleSave()
  }

  setPendingOrder(chatId, orderInput, summary) {
    const state = this.get(chatId)
    state.pendingOrder = { orderInput, summary }
    state.awaitingPaymentProof = null
    state.orderDraft = null
    this.scheduleSave()
  }

  setOrderDraft(chatId, draft) {
    const state = this.get(chatId)
    state.orderDraft = draft
    this.scheduleSave()
  }

  setAwaitingPaymentProof(chatId, orderInput, summary) {
    const state = this.get(chatId)
    state.awaitingPaymentProof = { orderInput, summary, proofReceived: false }
    state.pendingOrder = null
    state.orderDraft = null
    this.scheduleSave()
  }

  scheduleSave() {
    if (!this.filePath) return
    if (this.saveTimer) windowClearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.save().catch((error) => console.error('No se pudo guardar la memoria de conversaciones:', error))
    }, 120)
  }

  async save() {
    if (!this.filePath) return

    const data = Object.fromEntries(this.byChatId.entries())
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    await fs.writeFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  }
}

function normalizeState(value) {
  return {
    messages: Array.isArray(value?.messages) ? value.messages.slice(-12) : [],
    lastOrderId: value?.lastOrderId || null,
    pendingOrder: value?.pendingOrder || null,
    awaitingPaymentProof: value?.awaitingPaymentProof || null,
    orderDraft: value?.orderDraft || null,
  }
}

function windowClearTimeout(timer) {
  clearTimeout(timer)
}
