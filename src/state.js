export class ConversationStore {
  constructor() {
    this.byChatId = new Map()
  }

  get(chatId) {
    if (!this.byChatId.has(chatId)) {
      this.byChatId.set(chatId, {
        messages: [],
        lastOrderId: null,
        pendingOrder: null,
        awaitingPaymentProof: null,
        orderDraft: null,
      })
    }
    return this.byChatId.get(chatId)
  }

  add(chatId, role, text) {
    const state = this.get(chatId)
    state.messages.push({ role, text, at: Date.now() })
    state.messages = state.messages.slice(-12)
    return state
  }

  setLastOrder(chatId, orderId) {
    const state = this.get(chatId)
    state.lastOrderId = orderId
    state.pendingOrder = null
    state.awaitingPaymentProof = null
    state.orderDraft = null
  }

  setPendingOrder(chatId, orderInput, summary) {
    const state = this.get(chatId)
    state.pendingOrder = { orderInput, summary }
    state.awaitingPaymentProof = null
    state.orderDraft = null
  }

  setOrderDraft(chatId, draft) {
    const state = this.get(chatId)
    state.orderDraft = draft
  }

  setAwaitingPaymentProof(chatId, orderInput, summary) {
    const state = this.get(chatId)
    state.awaitingPaymentProof = { orderInput, summary }
    state.pendingOrder = null
    state.orderDraft = null
  }
}
