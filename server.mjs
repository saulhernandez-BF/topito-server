import "dotenv/config";
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const GEMINI_MODEL_FAST = process.env.GEMINI_MODEL_FAST || "gemini-2.5-flash-lite";
// Ortografía: tarea mecánica y de alto volumen -> se queda en Gemini (barato/gratis).
// Reescribir y Crear: copy de marca -> Claude, que respeta mejor el tono.
const CLAUDE_MODEL_REESCRIBIR = process.env.CLAUDE_MODEL_REESCRIBIR || "claude-sonnet-5";
const CLAUDE_MODEL_GENERATE = process.env.CLAUDE_MODEL_GENERATE || "claude-sonnet-5";
const EMBEDDING_MODEL = process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-001";
const EMBEDDING_DIMENSIONS = 768;
const REFERENCE_TOP_K = Number(process.env.REFERENCE_TOP_K) || 12;

if (!GOOGLE_API_KEY) {
	console.error(
		"Falta la variable de entorno GOOGLE_API_KEY. Crea un archivo .env (copia .env.example) con tu API key de Gemini.",
	);
	process.exit(1);
}
if (!ANTHROPIC_API_KEY) {
	console.error(
		"Falta la variable de entorno ANTHROPIC_API_KEY. Crea un archivo .env (copia .env.example) con tu API key de Anthropic.",
	);
	process.exit(1);
}

// Middleware manual de CORS
app.use((req, res, next) => {
	res.header("Access-Control-Allow-Origin", "*"); // permite cualquier origen
	res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
	res.header("Access-Control-Allow-Headers", "Content-Type");
	if (req.method === "OPTIONS") {
		return res.sendStatus(200); // responde al preflight
	}
	next();
});

// --- Marcas soportadas ---
// Cada marca tiene su propio dataset de tono (data/<marca>/tuning.json) y su propio
// cache de embeddings (data/<marca>/tuning-embeddings.json). El plugin manda `brand`
// en el body para elegir con cuál conversar; si no manda nada, se usa DEFAULT_BRAND.
const BRANDS = {
	benandfrank: { label: "Ben & Frank" },
	bombavista: { label: "Bombavista" },
};
const DEFAULT_BRAND = "benandfrank";
const MAX_REFERENCE_TEXT_LENGTH = 400; // descarta texto legal (avisos de privacidad, TyC, etc.)

function cosineSimilarity(a, b) {
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Mezcla Fisher-Yates: no muta el array original y da una distribución uniforme
function shuffle(arr) {
	const copy = [...arr];
	for (let i = copy.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[copy[i], copy[j]] = [copy[j], copy[i]];
	}
	return copy;
}

function loadBrandData(brandKey) {
	const dir = path.join(__dirname, "data", brandKey);
	const tuningPath = path.join(dir, "tuning.json");
	const embeddingsPath = path.join(dir, "tuning-embeddings.json");

	let rawReferenceData = [];
	try {
		rawReferenceData = JSON.parse(fs.readFileSync(tuningPath, "utf-8"));
	} catch {
		console.warn(`Aviso: no se encontró ${tuningPath}; "${brandKey}" no tiene ejemplos de tono todavía.`);
	}

	const referenceData = rawReferenceData.filter(
		(item) => (item.text?.length ?? 0) > 0 && item.text.length <= MAX_REFERENCE_TEXT_LENGTH,
	);
	console.log(
		`[${brandKey}] Referencia de tono: ${referenceData.length}/${rawReferenceData.length} textos usados ` +
			`(se descartaron ${rawReferenceData.length - referenceData.length} por vacíos o demasiado largos).`,
	);

	let referenceEmbeddings = null;
	try {
		const cache = JSON.parse(fs.readFileSync(embeddingsPath, "utf-8"));
		const cachedTexts = new Set(cache.items.map((i) => i.text));
		const missing = referenceData.filter((item) => !cachedTexts.has(item.text)).length;
		if (missing > 0) {
			console.warn(
				`[${brandKey}] Aviso: faltan ${missing} texto(s) en tuning-embeddings.json. ` +
					`Corre "npm run build-embeddings" para actualizarlo.`,
			);
		}
		referenceEmbeddings = cache.items;
		console.log(`[${brandKey}] Embeddings cargados: ${referenceEmbeddings.length} vectores.`);
	} catch {
		if (referenceData.length > 0) {
			console.warn(
				`[${brandKey}] Aviso: no se encontró tuning-embeddings.json. Corre "npm run build-embeddings" ` +
					`para activar la selección por relevancia; mientras tanto se usa muestreo al azar.`,
			);
		}
	}

	return { referenceData, referenceEmbeddings };
}

const brandData = {};
for (const brandKey of Object.keys(BRANDS)) {
	brandData[brandKey] = loadBrandData(brandKey);
}

function resolveBrand(req, res) {
	const brand = req.body?.brand || DEFAULT_BRAND;
	if (!BRANDS[brand]) {
		res.status(400).json({ error: `Marca desconocida: "${brand}". Usa una de: ${Object.keys(BRANDS).join(", ")}` });
		return null;
	}
	return brand;
}

function buildStyleReference(brand, sampleSize = 20) {
	const { referenceData } = brandData[brand];
	if (referenceData.length === 0) return "";
	const sampleData = shuffle(referenceData).slice(0, Math.min(sampleSize, referenceData.length));
	return sampleData.map((item) => item.text).join("\n\n");
}

// Embedding del texto de la petición (RETRIEVAL_QUERY), para compararlo contra los
// embeddings de referencia (RETRIEVAL_DOCUMENT) y elegir los más relevantes.
async function embedQuery(text) {
	const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent?key=${GOOGLE_API_KEY}`;
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model: `models/${EMBEDDING_MODEL}`,
			content: { parts: [{ text }] },
			taskType: "RETRIEVAL_QUERY",
			outputDimensionality: EMBEDDING_DIMENSIONS,
		}),
	});
	const data = await res.json();
	if (data.error) {
		throw new Error(`Error de Gemini embeddings: ${JSON.stringify(data.error)}`);
	}
	return data.embedding.values;
}

// Construye el bloque de ejemplos de tono para el prompt: los REFERENCE_TOP_K textos
// más parecidos (por embeddings) al texto de la petición, dentro de la marca elegida.
// Si esa marca no tiene embeddings o algo falla, cae de vuelta al muestreo al azar.
async function buildRelevantReference(promptText, endpointForLog, brand) {
	const { referenceEmbeddings } = brandData[brand];
	if (!referenceEmbeddings || referenceEmbeddings.length === 0) {
		return buildStyleReference(brand);
	}

	try {
		const queryVector = await embedQuery(promptText);
		logUsage({
			endpoint: `${endpointForLog}:embedding`,
			provider: "gemini-embedding",
			model: EMBEDDING_MODEL,
			inputTokens: Math.ceil(promptText.length / 4), // la API no regresa uso para embeddings; estimado
			outputTokens: 0,
		});

		const ranked = referenceEmbeddings
			.map((item) => ({ item, score: cosineSimilarity(queryVector, item.embedding) }))
			.sort((a, b) => b.score - a.score)
			.slice(0, REFERENCE_TOP_K);

		return ranked.map((r) => r.item.text).join("\n\n");
	} catch (err) {
		console.error(`[${brand}] Fallback a muestreo al azar (falló la selección por relevancia):`, err);
		return buildStyleReference(brand);
	}
}

// --- Precios por millón de tokens (USD), para estimar costo en el reporte de /usage ---
// Fuente: pricing oficial de Anthropic y Google, revisado en septiembre 2026.
// Si cambian los precios, solo hay que actualizar esta tabla.
const PRICING = {
	"gemini-2.5-flash-lite": { in: 0.10, out: 0.40 },
	"gemini-2.5-flash": { in: 0.30, out: 2.50 },
	"claude-sonnet-5": { in: 2.00, out: 10.00 },
	"claude-haiku-4-5-20251001": { in: 1.00, out: 5.00 },
	"gemini-embedding-001": { in: 0.15, out: 0 },
};

function estimateCostUsd(model, inputTokens, outputTokens) {
	const rate = PRICING[model];
	if (!rate) return null;
	return (inputTokens / 1_000_000) * rate.in + (outputTokens / 1_000_000) * rate.out;
}

// --- Registro de uso: un archivo .jsonl con una línea por llamada a la IA ---
// Sirve para el reporte de /usage (costo real acumulado, no solo estimado).
const USAGE_LOG_PATH = path.join(__dirname, "usage-log.jsonl");

function logUsage({ endpoint, provider, model, inputTokens, outputTokens }) {
	const entry = {
		timestamp: new Date().toISOString(),
		endpoint,
		provider,
		model,
		inputTokens,
		outputTokens,
		estimatedCostUsd: estimateCostUsd(model, inputTokens, outputTokens),
	};
	try {
		fs.appendFileSync(USAGE_LOG_PATH, JSON.stringify(entry) + "\n");
	} catch (err) {
		console.error("No se pudo escribir el log de uso:", err);
	}
}

// Llama a Gemini y devuelve { text, usage }
async function callGemini(promptText, model) {
	const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GOOGLE_API_KEY}`;

	const response = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			contents: [{ parts: [{ text: promptText }] }],
		}),
	});

	const data = await response.json();

	if (data.error) {
		console.error("Error de Gemini:", data.error);
		const error = new Error(data.error.message || "Error de la API de Gemini");
		error.details = data.error;
		throw error;
	}

	const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
	const usage = {
		inputTokens: data?.usageMetadata?.promptTokenCount ?? 0,
		outputTokens: data?.usageMetadata?.candidatesTokenCount ?? 0,
	};

	return { text, usage };
}

// Llama a Claude (Anthropic Messages API) y devuelve { text, usage }
async function callClaude(promptText, model) {
	const response = await fetch("https://api.anthropic.com/v1/messages", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-api-key": ANTHROPIC_API_KEY,
			"anthropic-version": "2023-06-01",
		},
		body: JSON.stringify({
			model,
			max_tokens: 1024,
			// El razonamiento extendido no aporta nada para copy corto y casi duplica
			// el costo de salida (se cobra como output tokens); lo desactivamos.
			thinking: { type: "disabled" },
			messages: [{ role: "user", content: promptText }],
		}),
	});

	const data = await response.json();

	if (data.error) {
		console.error("Error de Claude:", data.error);
		const error = new Error(data.error.message || "Error de la API de Claude");
		error.details = data.error;
		throw error;
	}

	// El primer bloque no siempre es el de texto (puede venir un bloque "thinking"
	// antes), así que se busca el bloque de tipo "text" en vez de asumir índice 0.
	const textBlock = (data?.content || []).find((block) => block.type === "text");
	const text = textBlock?.text || "";
	const usage = {
		inputTokens: data?.usage?.input_tokens ?? 0,
		outputTokens: data?.usage?.output_tokens ?? 0,
	};

	return { text, usage };
}

// Valida que el body traiga "prompt" como texto no vacío antes de gastar una llamada a la IA
function requirePrompt(req, res) {
	const { prompt } = req.body ?? {};
	if (typeof prompt !== "string" || prompt.trim().length === 0) {
		res.status(400).json({ error: "Falta el campo 'prompt' (texto) en el body." });
		return null;
	}
	return prompt;
}

app.post("/ortografia", async (req, res) => {
	const prompt = requirePrompt(req, res);
	if (prompt === null) return;

	try {
		const fullPrompt = `Corrige la ortografía y gramática del siguiente texto en español y solo escribe el texto corregido:\n\n${prompt}`;
		const { text: correctedText, usage } = await callGemini(fullPrompt, GEMINI_MODEL_FAST);
		logUsage({
			endpoint: "/ortografia",
			provider: "gemini",
			model: GEMINI_MODEL_FAST,
			...usage,
		});
		res.json({ correctedText });
	} catch (err) {
		console.error(err);
		res.status(500).json({ error: err.details ?? String(err) });
	}
});

app.post("/reescribir", async (req, res) => {
	const prompt = requirePrompt(req, res);
	if (prompt === null) return;
	const brand = resolveBrand(req, res);
	if (brand === null) return;

	try {
		const referenceText = await buildRelevantReference(prompt, "/reescribir", brand);
		const fullPrompt = `
Eres un asistente que debe crear textos publicitarios (copy) respetando mi voz y tono.
Aquí tienes ejemplos de mi estilo extraídos de la web e instagram, elegidos por ser los más
parecidos en tema al texto que me pediste reescribir:

${referenceText}

Ahora, con base en ese estilo, reescribe el siguiente texto para que se ajuste a mi voz y tono, solo dame un máximo de 4 opciones, no agregues nada más, los necesito en el formato de lista y limitate a solo poner las opciones no necesito nada antes ni despues de eso. el formato de lista siempre sera (* opcion1, * opcion2, * opcion3, * opcion4), no quiero que pongas ni un texto más:
${prompt}
`;
		const { text: correctedText, usage } = await callClaude(fullPrompt, CLAUDE_MODEL_REESCRIBIR);
		logUsage({
			endpoint: "/reescribir",
			provider: "claude",
			model: CLAUDE_MODEL_REESCRIBIR,
			...usage,
		});
		res.json({ correctedText });
	} catch (err) {
		console.error(err);
		res.status(500).json({ error: err.details ?? String(err) });
	}
});

app.post("/generate", async (req, res) => {
	const prompt = requirePrompt(req, res);
	if (prompt === null) return;
	const brand = resolveBrand(req, res);
	if (brand === null) return;

	try {
		const referenceText = await buildRelevantReference(prompt, "/generate", brand);
		const fullPrompt = `
Eres un asistente que debe crear textos publicitarios (copy) respetando mi voz y tono.
Aquí tienes ejemplos de mi estilo extraídos de la web e instagram, elegidos por ser los más
parecidos en tema a lo que me pediste:

${referenceText}

Ahora, con base en ese estilo, responde a esta petición:
${prompt}

Dame un máximo de 4 opciones, no agregues nada más, los necesito en el formato de lista y limitate a solo poner las opciones no necesito nada antes ni despues de eso. el formato de lista siempre sera (* opcion1, * opcion2, * opcion3, * opcion4), no quiero que pongas ni un texto más. No uses markdown (nada de negritas ni encabezados), no agregues emojis a menos que el ejemplo de tono los use, y no termines preguntando si quiero algo más.
`;
		const { text, usage } = await callClaude(fullPrompt, CLAUDE_MODEL_GENERATE);
		logUsage({
			endpoint: "/generate",
			provider: "claude",
			model: CLAUDE_MODEL_GENERATE,
			...usage,
		});
		res.json({ text });
	} catch (err) {
		console.error(err);
		res.status(500).json({ error: err.details ?? String(err) });
	}
});

app.post("/test", (req, res) => {
	const brand = resolveBrand(req, res);
	if (brand === null) return;
	const text = buildStyleReference(brand);
	res.json({ message: text, height: text.length });
});

// Marcas disponibles, para que el plugin arme el switch sin hardcodearlas.
app.get("/brands", (req, res) => {
	const brands = Object.entries(BRANDS).map(([key, { label }]) => ({
		key,
		label,
		referenceCount: brandData[key].referenceData.length,
	}));
	res.json({ brands, default: DEFAULT_BRAND });
});

// Reporte de uso y costo estimado, para decidir si el gasto en IA es viable.
// GET /usage  -> totales generales
// GET /usage?days=7 -> solo los últimos N días
app.get("/usage", (req, res) => {
	let lines = [];
	try {
		lines = fs
			.readFileSync(USAGE_LOG_PATH, "utf-8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
	} catch {
		lines = []; // aún no hay llamadas registradas
	}

	const days = Number(req.query.days);
	if (Number.isFinite(days) && days > 0) {
		const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
		lines = lines.filter((l) => new Date(l.timestamp).getTime() >= cutoff);
	}

	const summary = {
		requests: lines.length,
		totalInputTokens: 0,
		totalOutputTokens: 0,
		totalEstimatedCostUsd: 0,
		byEndpoint: {},
		byProvider: {},
	};

	for (const l of lines) {
		summary.totalInputTokens += l.inputTokens || 0;
		summary.totalOutputTokens += l.outputTokens || 0;
		summary.totalEstimatedCostUsd += l.estimatedCostUsd || 0;

		summary.byEndpoint[l.endpoint] ??= { requests: 0, estimatedCostUsd: 0 };
		summary.byEndpoint[l.endpoint].requests += 1;
		summary.byEndpoint[l.endpoint].estimatedCostUsd += l.estimatedCostUsd || 0;

		summary.byProvider[l.provider] ??= { requests: 0, estimatedCostUsd: 0 };
		summary.byProvider[l.provider].requests += 1;
		summary.byProvider[l.provider].estimatedCostUsd += l.estimatedCostUsd || 0;
	}

	summary.totalEstimatedCostUsd = Number(summary.totalEstimatedCostUsd.toFixed(6));
	for (const k of Object.keys(summary.byEndpoint)) {
		summary.byEndpoint[k].estimatedCostUsd = Number(summary.byEndpoint[k].estimatedCostUsd.toFixed(6));
	}
	for (const k of Object.keys(summary.byProvider)) {
		summary.byProvider[k].estimatedCostUsd = Number(summary.byProvider[k].estimatedCostUsd.toFixed(6));
	}

	res.json(summary);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
	console.log(`Server running on http://localhost:${PORT}`);
});
