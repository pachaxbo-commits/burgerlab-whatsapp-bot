function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLowerCase()
}

export function isConfirmedOrderStatusRequest(text) {
  const normalized = normalizeText(text)
  return (
    /\b(?:ya\s+)?(?:salio|despacharon|despachado|esta\s+list[oa]|esta\s+en\s+camino|llego|llega)\b/.test(normalized) ||
    /\b(?:cuanto\s+falta|cuando\s+sale|a\s+que\s+hora\s+sale|donde\s+esta)\b/.test(normalized)
  )
}

export function isConfirmedOrderModificationRequest(text) {
  const normalized = normalizeText(text)
  return /\b(?:agreg(?:ar|ame|ale)|aument(?:ar|ame|ale)|cambi(?:ar(?:lo|la)?|ame|ale)|sac(?:ar|ame|ale)|quit(?:ar|ame|ale)|modific(?:ar(?:lo|la)?|ame)|anad(?:ir|eme)|elimin(?:ar|a)|borr(?:ar|a))\b/.test(normalized)
}

export function shouldSuppressRepeatedOrderSummary(previousSummary, nextSummary, customerText = '') {
  if (!previousSummary || previousSummary !== nextSummary) return false

  const normalized = normalizeText(customerText)
  const explicitlyAskedToRepeat = (
    /\b(?:repite|repetir|reenvia|reenviame|vuelve\s+a\s+mandar|manda(?:me)?\s+otra\s+vez)\b/.test(normalized) &&
    /\b(?:resumen|pedido)\b/.test(normalized)
  )

  return !explicitlyAskedToRepeat
}
