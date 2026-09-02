// Precalcula embeddings para cada marca (data/<marca>/tuning.json) y los guarda en
// data/<marca>/tuning-embeddings.json.
// Correr con: npm run build-embeddings (se puede correr varias veces seguidas,
// retoma donde se quedó -- útil porque el free tier de embeddings limita
// requests por minuto y una corrida completa puede tardar unos minutos).
import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const EMBEDDING_MODEL = process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-001";
const EMBEDDING_DIMENSIONS = 768;
const MAX_REFERENCE_TEXT_LENGTH = 400; // mismo criterio que en server.mjs: descarta texto legal
const BATCH_SIZE = 25; // el free tier limita requests/minuto; lotes chicos + pausa evitan el 429
const MAX_RUNTIME_MS = 100_000; // se corta antes del timeout de la terminal y guarda lo que lleve

const BRANDS = ["benandfrank", "bombavista"];

if (!GOOGLE_API_KEY) {
	console.error("Falta GOOGLE_API_KEY en .env");
	process.exit(1);
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function embedBatch(texts, attempt = 1) {
	const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:batchEmbedContents?key=${GOOGLE_API_KEY}`;
	const requests = texts.map((text) => ({
		model: `models/${EMBEDDING_MODEL}`,
		content: { parts: [{ text }] },
		taskType: "RETRIEVAL_DOCUMENT",
		outputDimensionality: EMBEDDING_DIMENSIONS,
	}));

	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ requests }),
	});
	const data = await res.json();

	if (data.error) {
		const isRateLimit = data.error.code === 429;
		if (isRateLimit && attempt <= 6) {
			const retryInfo = data.error.details?.find(
				(d) => d["@type"] === "type.googleapis.com/google.rpc.RetryInfo",
			);
			const retrySeconds = retryInfo?.retryDelay
				? parseFloat(retryInfo.retryDelay)
				: 15 * attempt;
			console.log(
				`  límite de tasa alcanzado, esperando ${Math.ceil(retrySeconds)}s (intento ${attempt}/6)...`,
			);
			await sleep((retrySeconds + 1) * 1000);
			return embedBatch(texts, attempt + 1);
		}
		throw new Error(`Error de Gemini embeddings: ${JSON.stringify(data.error)}`);
	}

	return data.embeddings.map((e) => e.values);
}

function loadExisting(outputPath) {
	if (!fs.existsSync(outputPath)) return { items: [] };
	try {
		return JSON.parse(fs.readFileSync(outputPath, "utf-8"));
	} catch {
		return { items: [] };
	}
}

function save(outputPath, items) {
	const output = {
		model: EMBEDDING_MODEL,
		dimensions: EMBEDDING_DIMENSIONS,
		generatedAt: new Date().toISOString(),
		items,
	};
	fs.writeFileSync(outputPath, JSON.stringify(output));
}

async function processBrand(brand, startedAt) {
	const dir = path.join(ROOT, "data", brand);
	const tuningPath = path.join(dir, "tuning.json");
	const outputPath = path.join(dir, "tuning-embeddings.json");

	if (!fs.existsSync(tuningPath)) {
		console.log(`[${brand}] no existe ${tuningPath}, se salta.`);
		return;
	}

	const rawReferenceData = JSON.parse(fs.readFileSync(tuningPath, "utf-8"));
	const referenceData = rawReferenceData.filter(
		(item) => (item.text?.length ?? 0) > 0 && item.text.length <= MAX_REFERENCE_TEXT_LENGTH,
	);

	if (referenceData.length === 0) {
		console.log(`[${brand}] tuning.json no tiene textos usables todavía, se salta.`);
		return;
	}

	const existing = loadExisting(outputPath);
	const alreadyDone = new Set(existing.items.map((i) => i.text));
	const pending = referenceData.filter((item) => !alreadyDone.has(item.text));

	console.log(
		`[${brand}] ${referenceData.length} textos de referencia (se descartaron ${rawReferenceData.length - referenceData.length} por texto legal/vacío). ` +
			`Ya calculados: ${existing.items.length}. Pendientes: ${pending.length}.`,
	);

	if (pending.length === 0) {
		console.log(`[${brand}] nada pendiente, tuning-embeddings.json ya está completo.`);
		return;
	}

	const items = [...existing.items];

	for (let i = 0; i < pending.length; i += BATCH_SIZE) {
		if (Date.now() - startedAt > MAX_RUNTIME_MS) {
			console.log(
				`\n[${brand}] Se alcanzó el tiempo máximo de esta corrida. Progreso guardado: ${items.length}/${referenceData.length}. ` +
					`Vuelve a correr "npm run build-embeddings" para continuar.`,
			);
			save(outputPath, items);
			return "timeout";
		}

		const chunk = pending.slice(i, i + BATCH_SIZE);
		process.stdout.write(
			`[${brand}]   lote ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(pending.length / BATCH_SIZE)} (${chunk.length} textos)...`,
		);
		const vectors = await embedBatch(chunk.map((item) => item.text));
		chunk.forEach((item, idx) => {
			items.push({ text: item.text, url: item.url, source: item.source, embedding: vectors[idx] });
		});
		save(outputPath, items); // progreso incremental, por si se corta a la mitad
		console.log(" listo, guardado");

		if (i + BATCH_SIZE < pending.length) {
			await sleep(2000);
		}
	}

	console.log(`[${brand}] Listo: ${items.length} vectores en total.\n`);
}

async function main() {
	const startedAt = Date.now();
	let anyTimeout = false;
	for (const brand of BRANDS) {
		const result = await processBrand(brand, startedAt);
		if (result === "timeout") {
			anyTimeout = true;
			break; // el resto de marcas se procesa en la siguiente corrida
		}
	}
	if (!anyTimeout) {
		console.log("Listo. Todos los embeddings están al día.");
	} else {
		console.log("Quedó pendiente al menos una marca. Vuelve a correr \"npm run build-embeddings\" para continuar.");
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
