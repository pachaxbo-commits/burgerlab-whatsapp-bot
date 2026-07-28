import { GoogleGenAI } from '@google/genai'
import { z } from 'zod'
import { config } from './config.js'
import { getSettings } from './settings.js'

let geminiClient = null

const nullableEnum = (values) =>
  z.preprocess((value) => {
    if (value === 'null' || value === '' || value === undefined) return null
    return value
  }, z.enum(values).nullable().default(null))

const numberOrDefault = (fallback) =>
  z.preprocess((value) => {
    const num = Number(value)
    return Number.isFinite(num) ? num : fallback
  }, z.number())

const orderSchema = z.object({
  intent: z.enum(['greeting', 'question', 'menu_request', 'order_draft', 'order_ready', 'confirm_order', 'cancel_order', 'delivery_pricing', 'payment_qr_request', 'human_help', 'other']),
  reply: z.string(),
  missingFields: z.array(z.string()).default([]),
  customerName: z.string().default(''),
  customerPhone: z.string().default(''),
  paymentMethod: nullableEnum(['cash', 'qr', 'mixed']),
  fulfillmentType: nullableEnum(['pickup', 'delivery']),
  deliveryAddress: z.string().default(''),
  items: z
    .array(
      z.object({
        productId: z.string(),
        name: z.string(),
        basePrice: numberOrDefault(0),
        quantity: numberOrDefault(1).transform((value) => (value > 0 ? Math.round(value) : 1)),
        note: z.string().default(''),
        options: z.array(z.string()).default([]),
        extras: z.array(z.object({ id: z.string(), name: z.string(), price: numberOrDefault(0) })).default([]),
      }),
    )
    .default([]),
})

function buildEmptyAiResult() {
  return {
    intent: 'order_draft',
    reply: '',
    missingFields: [],
    customerName: '',
    customerPhone: '',
    paymentMethod: null,
    fulfillmentType: null,
    deliveryAddress: '',
    items: [],
  }
}

export async function understandMessage({ message, conversation, catalog, currentDraft }) {
  const prompt = buildPrompt({ message, conversation, catalog, currentDraft })
  let text = '{}'
  if (config.openaiApiKey) {
    try {
      text = await generateOpenAiWithRetry(prompt)
    } catch (openaiError) {
      console.error('Error llamando a OpenAI API:', openaiError)
      if (config.geminiApiKey) {
        text = (await generateContentWithRetry(prompt)).text || '{}'
      } else {
        return buildEmptyAiResult()
      }
    }
  } else if (config.geminiApiKey) {
    try {
      text = (await generateContentWithRetry(prompt)).text || '{}'
    } catch (geminiError) {
      console.error('Error llamando a Gemini API:', geminiError)
      return buildEmptyAiResult()
    }
  }

  try {
    const rawObject = JSON.parse(text || '{}')
    if (Array.isArray(rawObject.items)) {
      rawObject.items = rawObject.items.map((item) => ({
        ...item,
        extras: Array.isArray(item.extras) ? item.extras : [],
        options: Array.isArray(item.options) ? item.options : [],
        quantity: Math.min(Math.max(Number(item.quantity || 1), 1), 20),
      }))
    }
    return orderSchema.parse(rawObject)
  } catch (parseError) {
    console.error('Error parseando o validando JSON de la IA:', parseError)
    return buildEmptyAiResult()
  }
}

async function generateOpenAiWithRetry(prompt) {
  try {
    return await generateOpenAi(prompt)
  } catch (error) {
    if (!isTemporaryOpenAiError(error)) throw error
    await new Promise((resolve) => setTimeout(resolve, 700))
    return generateOpenAi(prompt)
  }
}

async function generateOpenAi(prompt) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openaiApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.openaiModel,
      temperature: 0.25,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: 'Eres un extractor y asistente de pedidos de restaurante. Responde solo JSON valido.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
    }),
  })

  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(body?.error?.message || `OpenAI error ${response.status}`)
    error.status = response.status
    throw error
  }

  return body?.choices?.[0]?.message?.content || '{}'
}

function isTemporaryOpenAiError(error) {
  const status = Number(error?.status || error?.code || 0)
  const message = String(error?.message || '')
  return status === 408 || status === 409 || status === 429 || status >= 500 || /rate|timeout|temporarily|overloaded/i.test(message)
}

async function generateContentWithRetry(prompt) {
  try {
    return await generateContent(prompt)
  } catch (error) {
    if (!isTemporaryGeminiError(error)) throw error
    await new Promise((resolve) => setTimeout(resolve, 900))
    return generateContent(prompt)
  }
}

function generateContent(prompt) {
  if (!geminiClient) {
    geminiClient = new GoogleGenAI({ apiKey: config.geminiApiKey })
  }

  return geminiClient.models.generateContent({
    model: config.geminiModel,
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      temperature: 0.4,
    },
  })
}

function isTemporaryGeminiError(error) {
  const status = Number(error?.status || error?.code || 0)
  const message = String(error?.message || '')
  return status === 429 || status === 500 || status === 503 || /UNAVAILABLE|high demand|quota|rate/i.test(message)
}

function buildPrompt({ message, conversation, catalog, currentDraft }) {
  const catalogLines = catalog.products
    .map((product) => {
      // Combina los extras del producto y los quickExtras globales (solo para hamburguesas)
      const allExtras = [...(product.extras || [])]
      if (product.categoryId === 'hamburguesas' && Array.isArray(catalog.quickExtras)) {
        catalog.quickExtras.forEach((qe) => {
          if (!allExtras.some((e) => e.id === qe.id)) {
            allExtras.push(qe)
          }
        })
      }
      const extras = allExtras.length
        ? ` Extras/Adicionales disponibles: ${allExtras.map((extra) => `${extra.name} +${extra.price}`).join(', ')}.`
        : ''
      return `- id=${product.id}; ${product.name}; precio=${product.price}; categoria=${product.categoryId}.${extras}`
    })
    .join('\n')

  return `
Eres el bot de WhatsApp de ${config.businessName}.
Personalidad: ${getSettings().personality || config.personality}

Objetivo:
- Responder natural, corto y claro.
- Ayudar al cliente a registrar un pedido.
- No inventar productos ni precios; usa solo el catalogo.
- Si el cliente saluda o hace una pregunta normal del negocio, responde de forma amigable y ofrece tomar el pedido.
- Si el cliente pregunta cuánto cuesta el delivery/envio/tarifa, devuelve intent="delivery_pricing".
- Si el cliente quiere pagar por QR o pide QR/comprobante, devuelve intent="payment_qr_request".
- Si el cliente pide ver el menú, la carta, los productos o precios disponibles (incluso con errores de tipeo o frases raras como "mandame el menu", "el me u", "que tienen"), devuelve intent="menu_request". El sistema le manda la imagen real del menú automáticamente - en el campo "reply" NO listes tú los productos ni inventes tu propia versión del menú.
- Si el cliente hace preguntas muy raras, incoherentes, groseras, no relacionadas con comida/restaurante o que requieren decision humana, devuelve intent="human_help".
- NUNCA improvises ni redactes tú mismo el formato/estructura de datos que se le pide al cliente (nombre, celular, entrega, pedido) en el campo "reply". Si el cliente necesita ese formato (porque quiere pedir pero aun no dio todos los datos, o no diste con items claros), devuelve intent="order_draft" con items vacío o incompleto y deja missingFields indicando lo que falta - el sistema se encarga de mandarle el formato/ejemplo correcto siempre igual, tu "reply" en ese caso no se usa.
- El método de pago NO es un dato obligatorio: si el cliente no menciona "QR" en ningún momento, asume que paga en efectivo (paymentMethod="cash") y NO se lo preguntes. Solo si el cliente escribe explícitamente que quiere pagar por QR, usa paymentMethod="qr".
- El número de celular SÍ es un dato obligatorio (customerPhone). Si el cliente no lo dio, indícalo en missingFields.
- Si el cliente NO usa la plantilla o envía sus datos en varios mensajes informales, PROCESA E INFIERE IGUALMENTE toda la información que el cliente vaya dando paso a paso sin exigir obligatoriamente la plantilla.
- No crees el pedido hasta tener los datos requeridos (nombre, numero de celular, items del catálogo y tipo de entrega).
- Si el cliente pide extras/adicionales (ej. "con extra de queso", "salsa golf adicional"), agrégalos a la lista "extras" de ese item con el id, name y price exactos que figuran en el catálogo.
- Si pide varias unidades de un mismo extra (ej. "2 de salsa golf", "con doble de salsa bbq"), agrega ese extra múltiples veces en la lista "extras" del item correspondiente (tantas veces como se haya pedido, ej: 2 elementos iguales si pidió doble).
- Cuando ya tengas el pedido completo, devuelve intent="order_ready" y en reply muestra el resumen exacto con total y pregunta: "Confirmas el pedido?"
- Si el cliente confirma un resumen pendiente con palabras como si, confirmo, correcto, dale o ok, devuelve intent="confirm_order".
- Si el cliente cancela o quiere cambiar, devuelve intent="cancel_order" u "order_draft" segun corresponda.
- Si el metodo es QR, puede ser pago anticipado y recojo en restaurante.
- Si es delivery, pide ubicacion de WhatsApp o direccion. Si manda direccion escrita, aceptala y colocala en deliveryAddress.
- No calcules costo de envio. El delivery lo cobra la moto directo al cliente.
- REGLA ABSOLUTA DE EXTRAS: Solo asigna un extra si el cliente nombró de forma explícita el nombre exacto de ese extra (aceptando sinónimos claros: "una porción de papas extra", "una ración de papas" y "doble porción de papas" se refieren al mismo extra de papas). Queda ESTRICTAMENTE PROHIBIDO adivinar, asumir o sustituir extras (ej. nunca cambies piña por salsa verde, ni agregues salsas no pedidas).
- IMPORTANTE - un mensaje puede describir VARIOS items distintos a la vez (ej. "una BBQ con doble tocino y una Burger Lab sin cebolla"): identifica cada hamburguesa/producto por separado como un item independiente en la lista "items", y asegurate de que cada extra, nota o modificador quede asociado SOLO al item al que el cliente se refería, no a todos los items del pedido.
- Ten cuidado de no confundir el tamaño de la hamburguesa (simple/doble) con la cantidad de un extra/topping (ej. "doble porción de tocino" o "doble tocino" es 2 unidades del extra tocino en una hamburguesa que puede seguir siendo simple; no la conviertas en hamburguesa doble solo por esa frase).
- El catálogo normalmente solo tiene hamburguesas "simple" y "doble". Si el cliente pide "triple" (u otra variante superior que no exista), trátala como la version "doble" del producto y agrega un extra de carne adicional si existe algo como "Carne extra" en el catálogo; si no existe ese extra, deja una nota indicando "carne extra (triple)" en el item y menciona el ajuste en el reply para que el cliente lo confirme.
- Si el cliente menciona un producto genérico sin especificar cuál (ej. solo dice "2 hamburguesas" sin decir cuál del menú), NO adivines ni elijas por él: deja items vacío para eso, indica en missingFields que falta especificar cuál hamburguesa, y en el reply pregunta explícitamente cuáles hamburguesas del menú desea (menciona las opciones: Burger Lab o BBQ Lab, simple o doble, con o sin papas).
- Si el cliente pide agregar, aumentar, quitar o cambiar algo de un pedido que ya venías armando en la conversación, ACTUALIZA la lista de items combinando lo nuevo con lo que ya tenías (no reinicies el pedido ni vuelvas a pedir datos que el cliente ya dio antes en la conversación).
- Detalles como sin mantequilla, sin salsa, sin cebolla, salsa aparte o cambios similares deben ir en note del item correspondiente.
- Si falta algo, missingFields debe indicarlo.

Catalogo disponible:
${catalogLines}
${currentDraft?.items?.length ? `
Pedido que ya se venia armando en esta conversacion (parte de lo cual el cliente ya confirmo o menciono antes; el "Mensaje nuevo del cliente" de abajo puede estar agregando, quitando o corrigiendo algo de ESTO, no necesariamente reemplazandolo todo):
Nombre: ${currentDraft.customerName || '(sin definir)'}
Celular: ${currentDraft.customerPhone || '(sin definir)'}
Metodo de pago: ${currentDraft.paymentMethod === 'qr' ? 'QR' : 'Efectivo (por defecto)'}
Entrega: ${currentDraft.fulfillmentType || '(sin definir)'}
Items:
${currentDraft.items.map((item) => `- ${item.quantity} x ${item.name}${item.extras?.length ? ` + ${item.extras.map((e) => e.name).join(', ')}` : ''}${item.note ? ` (${item.note})` : ''}`).join('\n')}
` : ''}
Conversacion resumida:
${conversation.map((entry) => `${entry.role}: ${entry.text}`).join('\n')}

Mensaje nuevo del cliente:
${message}

Devuelve SOLO JSON con esta forma:
{
  "intent": "greeting|question|order_draft|order_ready|confirm_order|cancel_order|delivery_pricing|payment_qr_request|human_help|other",
  "reply": "respuesta para WhatsApp",
  "missingFields": ["Nombre", "Metodo de pago"],
  "customerName": "",
  "customerPhone": "",
  "paymentMethod": "cash|qr|mixed|null",
  "fulfillmentType": "pickup|delivery|null",
  "deliveryAddress": "",
  "items": [
    {
      "productId": "id del catalogo",
      "name": "nombre",
      "basePrice": 25,
      "quantity": 1,
      "note": "",
      "options": [],
      "extras": []
    }
  ]
}
`
}
