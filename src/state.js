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
    state.lastMessageAt = Date.now()
    this.scheduleSave()
    return state
  }

  isNewSession(chatId, gapMs) {
    const state = this.byChatId.get(chatId)
    if (!state || !state.lastMessageAt) return false
    return Date.now() - state.lastMessageAt > gapMs
  }

  resetSession(chatId) {
    const state = this.get(chatId)
    state.messages = []
    state.pendingOrder = null
    state.pendingClarification = null
    state.awaitingPaymentProof = null
    state.orderDraft = null
    // lastOrderId tambien se olvida: sin esto, un cliente que vuelve despues de un rato (o pide
    // explicitamente "otro pedido") seguia disparando la logica de "esto es una modificacion de
    // tu pedido ya confirmado" para su proximo pedido, que es realmente uno nuevo y separado.
    state.lastOrderId = null
    this.scheduleSave()
  }

  setLastOrder(chatId, orderId) {
    const state = this.get(chatId)
    state.lastOrderId = orderId
    state.pendingOrder = null
    state.pendingClarification = null
    state.awaitingPaymentProof = null
    state.orderDraft = null
    this.scheduleSave()
  }

  setPendingOrder(chatId, orderInput, summary) {
    const state = this.get(chatId)
    state.pendingOrder = { orderInput, summary }
    state.pendingClarification = null
    state.awaitingPaymentProof = null
    state.orderDraft = null
    this.scheduleSave()
  }

  setOrderDraft(chatId, draft) {
    const state = this.get(chatId)
    state.orderDraft = draft
    // Si el pedido volvio a estar en construccion, el resumen que se mostro antes ya no vale.
    // Sin esto quedaba guardado el viejo: un cliente cambio a delivery y despues pidio agregar
    // una hamburguesa, y el bot le mostro el resumen anterior, que todavia decia "Recojo en
    // restaurante" y no tenia la hamburguesa nueva.
    state.pendingOrder = null
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
    // Aclaracion que el bot esta esperando ahora mismo (ej. 'papas'). Sin esto, la respuesta
    // "una con papas" se procesa como si fuera un pedido nuevo en vez de la respuesta a la
    // pregunta que acabamos de hacer.
    pendingClarification: value?.pendingClarification || null,
    lastMessageAt: Number(value?.lastMessageAt) || 0,
  }
}

function windowClearTimeout(timer) {
  clearTimeout(timer)
}
