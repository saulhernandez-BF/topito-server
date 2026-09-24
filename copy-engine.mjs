// =============================================================================
// Motor de copy: instrucciones de salida en JSON, parseo, conteo de caracteres
// por campo y armado del resultado. Lo usan /reescribir y /generate (server.mjs),
// así que el plugin de Figma y Slack reciben exactamente lo mismo.
//
// Cada formato (FORMATS en server.mjs) define sus "fields":
//   { key, label, max?, firstLineMax? }
// Ej. email → asunto (≤50) + preheader (≤90). Si una opción se pasa, server.mjs
// pide UNA versión recortada solo de esas opciones antes de responder.
// =============================================================================

export const ANGLES = {
	precio: "💲 Precio",
	estilo: "✨ Estilo",
	beneficio: "👓 Beneficio",
	urgencia: "⏰ Urgencia",
};

// Conteo como lo ve una persona (un emoji = 1), no bytes.
export const countChars = (s) => [...String(s ?? "")].length;

const DEFAULT_FIELDS = [{ key: "texto", label: "Texto" }];
export const fieldsOf = (formatDef) => (formatDef?.fields?.length ? formatDef.fields : DEFAULT_FIELDS);

// Bloque del prompt que define la forma exacta de la respuesta.
export function outputInstructions({ formatDef, angles, count = 4 }) {
	const fields = fieldsOf(formatDef);
	const example = {};
	if (angles) example.angulo = "precio";
	for (const f of fields) example[f.key] = "...";
	const limits = fields
		.flatMap((f) => [
			f.max ? `"${f.key}" ≤ ${f.max} caracteres` : null,
			f.firstLineMax ? `la primera línea de "${f.key}" ≤ ${f.firstLineMax} caracteres (es lo que se ve antes del "ver más")` : null,
		])
		.filter(Boolean);

	let out = `\nResponde ÚNICAMENTE con un JSON válido, sin markdown, sin \`\`\` y sin texto antes o después, con esta forma exacta:
{"opciones":[${JSON.stringify(example)}, ...]}
- Exactamente ${count} opciones distintas entre sí.`;
	if (limits.length) {
		out += `\n- Límites ESTRICTOS (cuentan espacios, signos y emojis): ${limits.join("; ")}. Si una idea no cabe, reescríbela más corta; nunca te pases.`;
	}
	if (angles) {
		out += `\n- "angulo": cada opción con un ángulo diferente, uno de: ${Object.keys(ANGLES).join(", ")}. El copy debe notar ese ángulo (precio = valor/ahorro, estilo = moda/look, beneficio = lo que resuelve, urgencia = tiempo limitado/acción ya) sin inventar promociones, precios ni fechas que no estén en la petición.`;
	}
	out += `\n- No uses markdown ni negritas; emojis solo si los ejemplos de tono los usan; no agregues comentarios ni preguntas.`;
	return out;
}

// Extrae las opciones del texto del modelo. Si no viene JSON válido, cae al
// formato viejo de lista ("* opción") para no romper nada.
export function parseCopyResponse(raw, formatDef) {
	const fields = fieldsOf(formatDef);
	const text = String(raw || "").replace(/```(?:json)?/gi, "").trim();
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start !== -1 && end > start) {
		try {
			const data = JSON.parse(text.slice(start, end + 1));
			const list = Array.isArray(data) ? data : data.opciones || data.options || [];
			const options = list
				.map((o) => {
					if (typeof o === "string") o = { [fields[0].key]: o };
					const values = {};
					for (const f of fields) values[f.key] = String(o?.[f.key] ?? "").trim();
					// Formato de un solo campo: aceptar "texto" aunque el modelo use otro nombre.
					if (fields.length === 1 && !values[fields[0].key]) {
						values[fields[0].key] = String(o?.texto ?? o?.text ?? o?.copy ?? "").trim();
					}
					const angle = ANGLES[String(o?.angulo || "").toLowerCase()] ? String(o.angulo).toLowerCase() : null;
					return { angle, values };
				})
				.filter((o) => Object.values(o.values).some(Boolean));
			if (options.length) return options.slice(0, 4);
		} catch {
			/* cae al parseo de lista */
		}
	}
	return parseLegacyList(text).map((t) => ({ angle: null, values: { [fields[0].key]: t } }));
}

function parseLegacyList(raw) {
	const lines = String(raw || "").replace(/\r/g, "").split("\n");
	const bullet = /^\s*(?:[*\-•]|\d+[.)])\s+/;
	const out = [];
	if (lines.some((l) => bullet.test(l))) {
		for (const line of lines) {
			if (bullet.test(line)) out.push(line.replace(bullet, "").trim());
			else if (line.trim() && out.length) out[out.length - 1] += "\n" + line.trim();
		}
	} else if (raw.trim()) {
		out.push(raw.trim());
	}
	return out.map((o) => o.replace(/^["“]|["”]$/g, "").trim()).filter(Boolean).slice(0, 4);
}

// Mide cada campo contra su límite.
export function checkOption(option, formatDef) {
	const fields = fieldsOf(formatDef).map((f) => {
		const value = option.values[f.key] || "";
		const length = countChars(value);
		const firstLine = value.split("\n")[0];
		const firstLineLength = countChars(firstLine);
		const ok = (!f.max || length <= f.max) && (!f.firstLineMax || firstLineLength <= f.firstLineMax);
		return { key: f.key, label: f.label, value, length, max: f.max ?? null, firstLineLength, firstLineMax: f.firstLineMax ?? null, ok };
	});
	return { ...option, fields, ok: fields.every((f) => f.ok) };
}

// Texto "plano" de una opción (lo que se copia / califica / inserta en Figma).
export function optionText(option, formatDef) {
	const fields = fieldsOf(formatDef);
	if (fields.length === 1) return option.values[fields[0].key] || "";
	return fields.map((f) => `${f.label}: ${option.values[f.key] || ""}`).join(" · ");
}

// Formato de lista que el plugin de Figma ya sabe leer: una opción por línea.
export function toLegacyList(options) {
	return options.map((o) => `* ${o.text.replace(/\s*\n\s*/g, " ")}`).join("\n");
}

// Prompt para recortar solo las opciones que se pasaron del límite.
export function shortenPrompt({ failing, formatDef, angles }) {
	const payload = failing.map((o) => {
		const obj = {};
		if (angles && o.angle) obj.angulo = o.angle;
		for (const f of o.fields) obj[f.key] = f.value;
		return obj;
	});
	return `Estas opciones de copy se pasan del límite de caracteres. Recórtalas conservando la idea, el tono y (si aplica) el ángulo. No cambies nada que no haga falta.
${JSON.stringify({ opciones: payload })}
${outputInstructions({ formatDef, angles, count: payload.length })}`;
}

// =============================================================================
// Limpieza de la base de ejemplos (la usan server.mjs y scripts/clean-tuning.mjs)
// =============================================================================

// Clave para detectar duplicados "iguales salvo detalles": sin acentos, sin
// mayúsculas, sin URLs, sin emojis ni signos. "¡Lentes desde $990!" y
// "lentes desde 990 🤓" quedan igual.
export function normalizeCopy(text) {
	return String(text || "")
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/https?:\/\/\S+/g, " ")
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

// Páginas legales del sitio (términos, aviso de privacidad...): no son tono de
// marca y se colaban como "ejemplos" en los prompts.
const JUNK_URL_RE = /(terminos|t%C3%A9rminos|aviso-de-privacidad|privacidad|politica|legal|cookies)/i;
export function isJunkCopy(item) {
	if (!item?.text) return true;
	if (item.source === "website" && JUNK_URL_RE.test(item.url || "")) return true;
	return false;
}

// Quita basura y duplicados normalizados (se queda con el primero que aparece).
export function cleanReferenceList(items) {
	const seen = new Set();
	const out = [];
	for (const item of items) {
		if (isJunkCopy(item)) continue;
		const key = normalizeCopy(item.text);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		out.push(item);
	}
	return out;
}
