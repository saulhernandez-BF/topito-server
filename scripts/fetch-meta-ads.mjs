// Extrae los copys (título + texto principal) de los anuncios de Meta Ads para
// Ben & Frank MX y Bombavista MX, y los agrega a data/<marca>/tuning.json (sin
// duplicar lo que ya había). Requiere META_ACCESS_TOKEN en .env (ver .env.example).
//
// Primera corrida (backfill completo): se puede correr varias veces seguidas --
// cada cuenta tiene miles de anuncios, así que toma varias corridas; el progreso
// de paginación se guarda en data/<marca>/.meta-ads-state.json y se retoma
// automáticamente si se corta a la mitad (por timeout o por el límite de tasa de
// Meta, ver ACCOUNT_THROTTLED más abajo).
//
// Corridas siguientes (refresh incremental): en cuanto una marca termina su
// backfill completo se guarda data/<marca>/.meta-ads-done con la fecha. Desde ahí,
// cada corrida solo pide a Meta los anuncios creados después de la última corrida
// exitosa (filtering por created_time), así que son rápidas y casi nunca chocan
// con el límite de tasa -- así se puede dejar corriendo periódicamente (ver
// .github/workflows/refresh-brand-data.yml) sin volver a escanear todo el historial.
//
// Para forzar un backfill completo de nuevo: borra data/<marca>/.meta-ads-done.
//
// Después de correr esto hay que correr: npm run build-embeddings (para que el
// server pueda usar los textos nuevos).
import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const META_API_VERSION = process.env.META_API_VERSION || "v25.0";
const BASE_URL = `https://graph.facebook.com/${META_API_VERSION}`;
const MAX_REFERENCE_TEXT_LENGTH = 400;
const FIELDS = "name,status,creative{body,title,object_story_spec,asset_feed_spec}";
const PAGE_LIMIT = 25; // con limit=100 Meta pide "reduce the amount of data" por estos campos anidados
const MAX_RUNTIME_MS = 95_000; // se corta antes del timeout de la terminal y guarda lo que lleve

// act_<id> por marca, según la documentación que compartió Sam (Marketing Digital).
const ACCOUNTS = {
	benandfrank: "act_10154078421154698",
	bombavista: "act_1154268958403844",
};

if (!META_ACCESS_TOKEN) {
	console.error(
		"Falta META_ACCESS_TOKEN en .env. Es el token de solo lectura (scope ads_read) que compartió Sam.",
	);
	process.exit(1);
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// Meta tiene límite de tasa por app, y a veces pide "reduce the amount of data"
// (code 1) en vez de tronar -- en ambos casos, esperar y reintentar sirve.
async function fetchJson(url, attempt = 1) {
	const res = await fetch(url);
	const data = await res.json();

	if (data.error) {
		// 80004 = límite de llamadas por cuenta de anuncios. La cuenta de Ben & Frank
		// está en el tier "development_access" de la Marketing API, que tiene límites
		// bajos -- por eso pasa seguido durante el backfill completo. La ventana de
		// este límite tarda varios minutos en resetearse -- no vale la pena esperarla
		// dentro de una sola corrida, mejor guardar el progreso y salir; la siguiente
		// corrida retoma justo donde se quedó.
		const isAccountThrottle = data.error.code === 80004;
		if (isAccountThrottle) {
			const err = new Error("ACCOUNT_THROTTLED");
			err.accountThrottled = true;
			// Meta manda en este header cuántos minutos faltan para que se libere el límite.
			try {
				const usage = JSON.parse(res.headers.get("x-business-use-case-usage") || "{}");
				const firstKey = Object.keys(usage)[0];
				const entry = firstKey && usage[firstKey][0];
				if (entry) {
					err.estimatedMinutesToRegainAccess = entry.estimated_time_to_regain_access;
					err.accessTier = entry.ads_api_access_tier;
				}
			} catch {
				/* si no viene el header, seguimos sin el dato */
			}
			throw err;
		}

		const retryable = [1, 4, 17, 32].includes(data.error.code);
		if (retryable && attempt <= 5) {
			const waitSeconds = 20 * attempt;
			console.log(`\n  aviso de Meta (${data.error.code}), esperando ${waitSeconds}s (intento ${attempt}/5)...`);
			await sleep(waitSeconds * 1000);
			return fetchJson(url, attempt + 1);
		}
		throw new Error(`Error de Meta Graph API: ${JSON.stringify(data.error)}`);
	}
	return data;
}

function extractTexts(ad) {
	const texts = [];
	const c = ad.creative || {};
	if (c.title) texts.push(c.title);
	if (c.body) texts.push(c.body);

	const afs = c.asset_feed_spec;
	if (afs) {
		for (const t of afs.titles || []) if (t.text) texts.push(t.text);
		for (const b of afs.bodies || []) if (b.text) texts.push(b.text);
	}
	return texts;
}

function statePath(brand) {
	return path.join(ROOT, "data", brand, ".meta-ads-state.json");
}

function donePath(brand) {
	return path.join(ROOT, "data", brand, ".meta-ads-done");
}

// null si nunca se terminó un backfill completo. Si ya se terminó, trae
// { backfillCompletedAt, lastIncrementalRunAt }.
function getDoneInfo(brand) {
	try {
		const raw = fs.readFileSync(donePath(brand), "utf-8").trim();
		// Compatibilidad con el formato viejo (solo un timestamp en texto plano).
		if (raw.startsWith("{")) return JSON.parse(raw);
		return { backfillCompletedAt: raw, lastIncrementalRunAt: raw };
	} catch {
		return null;
	}
}

function writeDoneInfo(brand, info) {
	fs.mkdirSync(path.join(ROOT, "data", brand), { recursive: true });
	fs.writeFileSync(donePath(brand), JSON.stringify(info, null, 2));
}

function markBackfillDone(brand) {
	const now = new Date().toISOString();
	writeDoneInfo(brand, { backfillCompletedAt: now, lastIncrementalRunAt: now });
}

function markIncrementalRun(brand, doneInfo) {
	writeDoneInfo(brand, { ...doneInfo, lastIncrementalRunAt: new Date().toISOString() });
}

function loadState(brand) {
	try {
		return JSON.parse(fs.readFileSync(statePath(brand), "utf-8"));
	} catch {
		return null;
	}
}

function saveState(brand, state) {
	fs.mkdirSync(path.join(ROOT, "data", brand), { recursive: true });
	fs.writeFileSync(statePath(brand), JSON.stringify(state));
}

function clearState(brand) {
	try {
		fs.unlinkSync(statePath(brand));
	} catch {
		/* no existía, no pasa nada */
	}
}

function mergeIntoTuning(brand, extractedTexts) {
	const dir = path.join(ROOT, "data", brand);
	fs.mkdirSync(dir, { recursive: true });
	const tuningPath = path.join(dir, "tuning.json");

	let existing = [];
	if (fs.existsSync(tuningPath)) {
		try {
			existing = JSON.parse(fs.readFileSync(tuningPath, "utf-8"));
		} catch {
			existing = [];
		}
	}
	const existingTexts = new Set(existing.map((e) => e.text));

	let added = 0;
	let skippedLong = 0;
	const merged = [...existing];
	for (const entry of extractedTexts) {
		if (entry.text.length > MAX_REFERENCE_TEXT_LENGTH) {
			skippedLong++;
			continue;
		}
		if (existingTexts.has(entry.text)) continue;
		existingTexts.add(entry.text);
		merged.push(entry);
		added++;
	}

	fs.writeFileSync(tuningPath, JSON.stringify(merged, null, 2));
	console.log(
		`[${brand}] ${added} textos nuevos agregados a data/${brand}/tuning.json (total ahora: ${merged.length}). ` +
			`${skippedLong} descartados por ser demasiado largos.`,
	);
	return added;
}

// Backfill completo: pagina todo /ads de la cuenta desde el principio (o retoma
// desde .meta-ads-state.json si una corrida anterior se cortó a la mitad).
async function processBackfill(brand, accountId, startedAt) {
	let state = loadState(brand);
	if (!state) {
		state = {
			nextUrl: `${BASE_URL}/${accountId}/ads?fields=${encodeURIComponent(FIELDS)}&limit=${PAGE_LIMIT}&access_token=${META_ACCESS_TOKEN}`,
			extracted: [],
			page: 0,
			adsCount: 0,
		};
	} else {
		console.log(`[${brand}] retomando backfill: ${state.adsCount} anuncios ya procesados, ${state.extracted.length} textos extraídos.`);
	}

	function flushProgress() {
		if (state.extracted.length > 0) {
			mergeIntoTuning(brand, state.extracted);
			state.extracted = [];
		}
		saveState(brand, state);
	}

	while (state.nextUrl) {
		if (Date.now() - startedAt > MAX_RUNTIME_MS) {
			flushProgress();
			console.log(
				`\n[${brand}] Se alcanzó el tiempo máximo de esta corrida (${state.adsCount} anuncios hasta ahora, ya mergeados a tuning.json). ` +
					`Vuelve a correr "npm run fetch-meta-ads" para continuar.`,
			);
			return "timeout";
		}

		state.page++;
		process.stdout.write(`[${brand}]   página ${state.page}...`);
		let data;
		try {
			data = await fetchJson(state.nextUrl);
		} catch (err) {
			if (err.accountThrottled) {
				flushProgress();
				const waitMsg = err.estimatedMinutesToRegainAccess != null
					? `Meta dice que hay que esperar ~${err.estimatedMinutesToRegainAccess} min (tier: ${err.accessTier}).`
					: "Espera un par de minutos.";
				console.log(
					`\n[${brand}] Meta limitó la cuenta por ahora (${state.adsCount} anuncios hasta el momento, ya mergeados a tuning.json). ` +
						`${waitMsg} Vuelve a correr "npm run fetch-meta-ads".`,
				);
				return { status: "throttled", waitMinutes: err.estimatedMinutesToRegainAccess };
			}
			throw err;
		}
		const batch = data.data || [];
		for (const ad of batch) {
			for (const raw of extractTexts(ad)) {
				const text = raw.trim();
				if (!text) continue;
				state.extracted.push({ url: `meta_ads:${accountId}:${ad.id}`, source: "meta_ads", text });
			}
		}
		state.adsCount += batch.length;
		console.log(` ${batch.length} anuncios (total: ${state.adsCount})`);

		state.nextUrl = data.paging?.next || null;
		saveState(brand, state); // progreso incremental, por si se corta a la mitad
		if (state.nextUrl) await sleep(800); // no golpear la API de golpe
	}

	console.log(`[${brand}] ${state.adsCount} anuncios descargados en total (backfill completo).`);
	if (state.extracted.length > 0) {
		mergeIntoTuning(brand, state.extracted);
	}
	clearState(brand);
	markBackfillDone(brand);
	return "done";
}

// Refresh incremental: ya se hizo el backfill completo antes, así que solo se piden
// los anuncios creados después de la última corrida exitosa (filtro created_time).
// Pensado para correr periódico (ej. GitHub Actions semanal) sin re-escanear todo.
async function processIncremental(brand, accountId, doneInfo, startedAt) {
	const sinceIso = doneInfo.lastIncrementalRunAt || doneInfo.backfillCompletedAt;
	const sinceUnix = Math.floor(new Date(sinceIso).getTime() / 1000);
	const filtering = encodeURIComponent(
		JSON.stringify([{ field: "created_time", operator: "GREATER_THAN", value: sinceUnix }]),
	);
	let url = `${BASE_URL}/${accountId}/ads?fields=${encodeURIComponent(FIELDS)}&limit=${PAGE_LIMIT}&filtering=${filtering}&access_token=${META_ACCESS_TOKEN}`;

	console.log(`[${brand}] refresh incremental: buscando anuncios creados después de ${sinceIso}...`);
	let extracted = [];
	let adsCount = 0;
	let page = 0;

	while (url) {
		if (Date.now() - startedAt > MAX_RUNTIME_MS) {
			mergeIntoTuning(brand, extracted);
			console.log(
				`\n[${brand}] (incremental) tiempo máximo alcanzado, ${adsCount} anuncios nuevos revisados hasta ahora. ` +
					`Vuelve a correr "npm run fetch-meta-ads" para seguir (no se pierde nada: la próxima corrida vuelve a pedir desde ${sinceIso}).`,
			);
			return "timeout";
		}

		page++;
		process.stdout.write(`[${brand}] (incremental)   página ${page}...`);
		let data;
		try {
			data = await fetchJson(url);
		} catch (err) {
			if (err.accountThrottled) {
				mergeIntoTuning(brand, extracted);
				const waitMsg = err.estimatedMinutesToRegainAccess != null
					? `Meta dice que hay que esperar ~${err.estimatedMinutesToRegainAccess} min (tier: ${err.accessTier}).`
					: "Espera un par de minutos.";
				console.log(`\n[${brand}] (incremental) Meta limitó la cuenta por ahora. ${waitMsg} Vuelve a correr "npm run fetch-meta-ads".`);
				return { status: "throttled", waitMinutes: err.estimatedMinutesToRegainAccess };
			}
			throw err;
		}
		const batch = data.data || [];
		for (const ad of batch) {
			for (const raw of extractTexts(ad)) {
				const text = raw.trim();
				if (!text) continue;
				extracted.push({ url: `meta_ads:${accountId}:${ad.id}`, source: "meta_ads", text });
			}
		}
		adsCount += batch.length;
		console.log(` ${batch.length} anuncios nuevos (total revisados: ${adsCount})`);

		url = data.paging?.next || null;
		if (url) await sleep(800);
	}

	if (extracted.length > 0) {
		mergeIntoTuning(brand, extracted);
	} else {
		console.log(`[${brand}] (incremental) sin anuncios nuevos desde ${sinceIso}.`);
	}
	// Solo se actualiza la marca de tiempo cuando la corrida termina completa (no en
	// timeout/throttle), así la siguiente corrida vuelve a cubrir la misma ventana --
	// el dedup en mergeIntoTuning hace que revisarla dos veces no genere duplicados.
	markIncrementalRun(brand, doneInfo);
	return "done";
}

async function processAccount(brand, accountId, startedAt) {
	const doneInfo = getDoneInfo(brand);
	if (doneInfo) {
		return processIncremental(brand, accountId, doneInfo, startedAt);
	}
	return processBackfill(brand, accountId, startedAt);
}

async function main() {
	const startedAt = Date.now();
	const results = {};
	for (const [brand, accountId] of Object.entries(ACCOUNTS)) {
		console.log(`\n[${brand}] Cuenta ${accountId}`);
		// El límite de tasa de Meta es por cuenta de anuncios, así que si una marca se
		// throttlea seguimos con la otra en vez de parar todo -- cada cuenta guarda su
		// propio progreso y se retoma por separado.
		results[brand] = await processAccount(brand, accountId, startedAt);
		if (Date.now() - startedAt > MAX_RUNTIME_MS) break;
	}
	if (Object.values(results).every((r) => r === "done")) {
		console.log("\nListo. Ahora corre: npm run build-embeddings");
	} else {
		console.log("\nQuedó pendiente al menos una marca. Vuelve a correr \"npm run fetch-meta-ads\" más tarde para continuar.");
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
