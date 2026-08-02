function digitsOnly(value) {
  return String(value || '').replace(/\D/g, '')
}

export function phoneFromChatId(chatId) {
  const jid = String(chatId || '').trim().toLowerCase()
  if (!jid || jid.endsWith('@lid') || jid.endsWith('@g.us')) return ''
  if (!jid.endsWith('@s.whatsapp.net') && !jid.endsWith('@c.us')) return ''

  // Los dispositivos vinculados pueden agregar ":numero-dispositivo" antes del dominio.
  const localPart = jid.split('@')[0].split(':')[0]
  const digits = digitsOnly(localPart)
  return digits.length >= 8 && digits.length <= 15 ? digits : ''
}

export function normalizeCustomerPhone(value) {
  const digits = digitsOnly(value)
  if (/^[67]\d{7}$/.test(digits)) return `591${digits}`
  return digits.length >= 8 && digits.length <= 15 ? digits : ''
}

export function resolveCustomerPhone(chatId, suppliedPhone = '') {
  return phoneFromChatId(chatId) || normalizeCustomerPhone(suppliedPhone)
}

export function formatCustomerPhone(value) {
  const digits = normalizeCustomerPhone(value)
  return digits ? `+${digits}` : 'Sin numero disponible'
}
