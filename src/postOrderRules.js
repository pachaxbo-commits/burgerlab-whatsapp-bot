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
