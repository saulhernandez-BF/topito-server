// Desempeño real de los copys en Meta Ads -> data/<marca>/performance.json
//
// Para que Topito aprenda de LO QUE FUNCIONA (no de todos los anuncios por igual):
//   1. Trae de Insights, por trimestre, las métricas por anuncio (impresiones,
//      clics al link, gasto y compras) de los anuncios con > MIN_AD_IMPRESSIONS.
//      Cache: data/<marca>/.ad-insights.json. Un trimestre se da por "cerrado" una
//      vez que se descarga 7 días después de terminar (ventana de atribución);
//      los abiertos se vuelven a pedir en cada corrida.
//   2. Trae el texto (título/cuerpo) de esos anuncios, 50 por llamada.
//      Cache: data/<marca>/.ad-texts.json.
//   3. Suma por texto (normalizado) y calcula un score 0..1 COMBINADO:
//        CTR (clics al link / impresiones, suavizado para textos con pocas
//        impresiones) como base, y si el texto tuvo compras suficientes, su costo
//        por compra (más bajo = mejor) pesa 30%.
//   4. Opcional (si hay SUPABASE_URL/SUPABASE_SERVICE_KEY): busca qué copys de Topito
//      (👍/⚪ y bandeja de Figma) terminaron en anuncios -> data/topito-published.json.
//
// Correr con: npm run fetch-ad-performance (lo corre el workflow diario).
// Si Meta limita la cuenta (tier development_access), guarda lo que lleva y sale;
// la siguiente corrida continúa.
import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { normalizeCopy } from "../copy-engine.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = process.env.META_ACCESS_TOKEN;
const API = `https://graph.facebook.com/${process.env.META_API_VERSION || "v25.0"}`;
const SINCE = process.env.AD_PERF_SINCE || "2022-01-01";
const MAX_RUNTIME_MS = Number(process.env.AD_PERF_MAX_RUNTIME_MS) || 100_000;
const MIN_AD_IMPRESSIONS = 1000; // por anuncio y trimestre: debajo de esto es ruido
const MIN_TEXT_IMPRESSIONS = 3000; // por texto (sumando anuncios) para darle score
const MIN_PURCHASES_FOR_CPA = 3;
const CTR_PRIOR_IMPRESSIONS = 5000; // suavizado: textos con pocas impresiones tienden a la mediana
const MAX_TEXT_LENGTH = 400;
const PURCHASE_TYPES = ["omni_purchase", "offsite_conversion.fb_pixel_purchase", "purchase"];

const ACCOUNTS = {
	benandfrank: "act_10154078421154698",
	bombavista: "act_1154268958403844",
};

if (!TOKEN) {
	console.error("Falta META_ACCESS_TOKEN.");
	process.exit(1);
}

const startedAt = Date.now();
const outOfTime = () => Date.now() - startedAt > MAX_RUNTIME_MS;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (p, fallback) => {
	try {
		return JSON.parse(fs.readFileSync(p, "utf-8"));
	} catch {
		return fallback;
	}
};
const writeJson = (p, data, pretty = false) => fs.writeFileSync(p, JSON.stringify(data, null, pretty ? 2 : 0));

class Throttled extends Error {}

async function graph(url, attempt = 1) {
	let data;
	try {
		const res = await fetch(url);
		data = await res.json();
	} catch (err) {
		// Corte de red / respuesta truncada: reintentar un par de veces.
		if (attempt <= 4) {
			await sleep(5000 * attempt);
			return graph(url, attempt + 1);
		}
		throw err;
	}
	if (!data.error) return data;
	const code = data.error.code;
	if (code === 80004 || code === 80000 || code === 17 || code === 613) {
		throw new Throttled(`Meta limitó la cuenta (code ${code})`);
	}
	if (code === 1 && attempt <= 3) {
		const u = new URL(url);
		const limit = Number(u.searchParams.get("limit")) || 100;
		u.searchParams.set("limit", String(Math.max(10, Math.floor(limit / 2))));
		await sleep(3000);
		return graph(u.toString(), attempt + 1);
	}
	if ([2, 4, 32].includes(code) && attempt <= 4) {
		await sleep(15_000 * attempt);
		return graph(url, attempt + 1);
	}
	throw new Error(`Meta Graph API: ${JSON.stringify(data.error).slice(0, 300)}`);
}

// Trimestres [inicio, fin] desde SINCE hasta hoy.
function quarters() {
	const out = [];
	// Meta solo da Insights de los últimos 37 meses: se recorta el inicio a 36.
	const today0 = new Date();
	const oldest = new Date(Date.UTC(today0.getUTCFullYear(), today0.getUTCMonth() - 36, 1));
	const start = new Date(Math.max(new Date(`${SINCE}T00:00:00Z`).getTime(), oldest.getTime()));
	let y = start.getUTCFullYear();
	let q = Math.floor(start.getUTCMonth() / 3);
	const today = new Date();
	for (;;) {
		const s = new Date(Date.UTC(y, q * 3, 1));
		if (s > today) break;
		const e = new Date(Date.UTC(y, q * 3 + 3, 0));
		const since = new Date(Math.max(s.getTime(), start.getTime()));
		out.push({ key: `${y}Q${q + 1}`, since: since.toISOString().slice(0, 10), until: e.toISOString().slice(0, 10), end: e });
		if (++q === 4) {
			q = 0;
			y++;
		}
	}
	return out;
}

function purchasesOf(row) {
	for (const t of PURCHASE_TYPES) {
		const a = (row.actions || []).find((x) => x.action_type === t);
		if (a) return Number(a.value) || 0;
	}
	return 0;
}

async function fetchInsights(brand, account, cache, save) {
	for (const qt of quarters()) {
		const prev = cache.quarters[qt.key];
		if (prev?.complete) continue;
		if (outOfTime()) return "time";
		const params = new URLSearchParams({
			level: "ad",
			fields: "ad_id,impressions,inline_link_clicks,spend,actions",
			time_range: JSON.stringify({ since: qt.since, until: qt.until }),
			filtering: JSON.stringify([{ field: "impressions", operator: "GREATER_THAN", value: MIN_AD_IMPRESSIONS }]),
			limit: "100",
			access_token: TOKEN,
		});
		let url = `${API}/${account}/insights?${params}`;
		const rows = {};
		while (url) {
			const data = await graph(url);
			for (const r of data.data || []) {
				rows[r.ad_id] = [Number(r.impressions) || 0, Number(r.inline_link_clicks) || 0, Number(r.spend) || 0, purchasesOf(r)];
			}
			url = data.paging?.next || null;
			if (url) await sleep(600);
		}
		const complete = Date.now() > qt.end.getTime() + 8 * 864e5;
		cache.quarters[qt.key] = { fetchedAt: new Date().toISOString(), complete, rows };
		save(); // guardar por trimestre: si la corrida se corta, no se pierde
		console.log(`[${brand}] ${qt.key}: ${Object.keys(rows).length} anuncios con desempeño${complete ? "" : " (trimestre abierto)"}`);
	}
	return "done";
}

function textsOfCreative(c = {}) {
	const t = [];
	if (c.title) t.push(c.title);
	if (c.body) t.push(c.body);
	for (const x of c.asset_feed_spec?.titles || []) if (x.text) t.push(x.text);
	for (const x of c.asset_feed_spec?.bodies || []) if (x.text) t.push(x.text);
	return [...new Set(t.map((s) => s.trim()).filter(Boolean))];
}

async function fetchTexts(brand, account, cache, texts, save) {
	const needed = new Set();
	for (const q of Object.values(cache.quarters)) for (const id of Object.keys(q.rows)) if (!(id in texts)) needed.add(id);
	const ids = [...needed];
	if (ids.length) console.log(`[${brand}] Textos por descargar: ${ids.length} anuncios`);
	for (let i = 0; i < ids.length; i += 50) {
		if (outOfTime()) return "time";
		const chunk = ids.slice(i, i + 50);
		// (?ids= ya no existe desde v26: se filtra /ads por id.)
		const params = new URLSearchParams({
			fields: "id,creative{title,body,asset_feed_spec}",
			filtering: JSON.stringify([{ field: "id", operator: "IN", value: chunk }]),
			limit: "50",
			access_token: TOKEN,
		});
		let url = `${API}/${account}/ads?${params}`;
		const found = {};
		while (url) {
			const data = await graph(url);
			for (const ad of data.data || []) found[ad.id] = textsOfCreative(ad.creative);
			url = data.paging?.next || null;
		}
		for (const id of chunk) texts[id] = found[id] || [];
		if ((i / 50) % 5 === 4) save();
		await sleep(600);
	}
	return "done";
}

function percentileRanks(values) {
	const sorted = [...values].sort((a, b) => a - b);
	return (v) => {
		let lo = 0;
		let hi = sorted.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (sorted[mid] < v) lo = mid + 1;
			else hi = mid;
		}
		return sorted.length > 1 ? lo / (sorted.length - 1) : 0.5;
	};
}

function buildPerformance(cache, texts) {
	const perAd = {};
	for (const q of Object.values(cache.quarters)) {
		for (const [id, [imp, clk, spend, purch]] of Object.entries(q.rows)) {
			const a = (perAd[id] ||= [0, 0, 0, 0]);
			a[0] += imp;
			a[1] += clk;
			a[2] += spend;
			a[3] += purch;
		}
	}
	const byText = new Map();
	for (const [id, [imp, clk, spend, purch]] of Object.entries(perAd)) {
		for (const text of texts[id] || []) {
			if (text.length > MAX_TEXT_LENGTH) continue;
			const key = normalizeCopy(text);
			if (!key) continue;
			const t = byText.get(key) || { text, key, impressions: 0, clicks: 0, spend: 0, purchases: 0, ads: 0 };
			t.impressions += imp;
			t.clicks += clk;
			t.spend += spend;
			t.purchases += purch;
			t.ads++;
			byText.set(key, t);
		}
	}
	// Fuera también los de alcance/video sin clics al link (CTR < 0.05%): su objetivo no
	// era el clic, así que su CTR no dice nada del copy -> quedan neutrales (sin score).
	const items = [...byText.values()].filter(
		(t) => t.impressions >= MIN_TEXT_IMPRESSIONS && t.clicks > 0 && t.clicks / t.impressions >= 0.0005,
	);
	if (!items.length) return [];
	const rawCtrs = items.map((t) => t.clicks / t.impressions).sort((a, b) => a - b);
	const medianCtr = rawCtrs[Math.floor(rawCtrs.length / 2)];
	for (const t of items) {
		t.ctr = t.clicks / t.impressions;
		t.smoothCtr = (t.clicks + CTR_PRIOR_IMPRESSIONS * medianCtr) / (t.impressions + CTR_PRIOR_IMPRESSIONS);
		t.cpa = t.purchases >= MIN_PURCHASES_FOR_CPA ? t.spend / t.purchases : null;
	}
	const ctrRank = percentileRanks(items.map((t) => t.smoothCtr));
	const withCpa = items.filter((t) => t.cpa != null);
	const cpaRank = percentileRanks(withCpa.map((t) => t.cpa));
	for (const t of items) {
		const ctrScore = ctrRank(t.smoothCtr);
		t.score = t.cpa != null && withCpa.length >= 10 ? 0.7 * ctrScore + 0.3 * (1 - cpaRank(t.cpa)) : ctrScore;
		t.score = Math.round(t.score * 1000) / 1000;
		t.ctr = Math.round(t.ctr * 1e5) / 1e5;
		t.spend = Math.round(t.spend);
		t.cpa = t.cpa == null ? null : Math.round(t.cpa);
		delete t.smoothCtr;
	}
	return items.sort((a, b) => b.score - a.score);
}

// --- ¿Qué copys de Topito llegaron a anuncios? ---
const tokens = (s) => new Set(normalizeCopy(s).split(" ").filter((w) => w.length > 2));
function similarity(a, b) {
	const A = tokens(a);
	const B = tokens(b);
	// Textos muy cortos ("Ben & Frank") coinciden con cualquier cosa: no cuentan.
	if (A.size < 4 || B.size < 4) return 0;
	let inter = 0;
	for (const w of A) if (B.has(w)) inter++;
	// "Contenido en" tolera que agreguen o quiten una frase, pero ambos textos deben
	// compartir al menos la mitad del total (evita que uno corto quepa en uno largo).
	if (inter / Math.max(A.size, B.size) < 0.5) return 0;
	return inter / Math.min(A.size, B.size);
}

async function findPublished(perfByBrand) {
	const url = process.env.SUPABASE_URL;
	const key = process.env.SUPABASE_SERVICE_KEY;
	if (!url || !key) return console.log("Sin Supabase: se omite la búsqueda de copys de Topito publicados.");
	const headers = { apikey: key };
	if (key.split(".").length === 3) headers.Authorization = `Bearer ${key}`;
	const get = async (q) => {
		const r = await fetch(`${url.replace(/\/$/, "")}/rest/v1/${q}`, { headers });
		if (!r.ok) throw new Error(`Supabase ${r.status}`);
		return r.json();
	};
	const [fb, inbox] = await Promise.all([
		get("feedback?select=brand,text,created_at,channel&rating=in.(like,neutral)&order=id.desc&limit=2000"),
		get("figma_inbox?select=brand,text,created_at&order=id.desc&limit=2000").catch(() => []),
	]);
	const candidates = [...fb.map((r) => ({ ...r, via: r.channel || "feedback" })), ...inbox.map((r) => ({ ...r, via: "figma-inbox" }))];
	const matches = [];
	const seen = new Set();
	for (const c of candidates) {
		const perf = perfByBrand[c.brand] || [];
		let best = null;
		for (const p of perf) {
			const s = similarity(c.text, p.text);
			if (s >= 0.8 && (!best || s > best.s)) best = { s, p };
		}
		if (!best || seen.has(best.p.key)) continue;
		seen.add(best.p.key);
		matches.push({
			brand: c.brand,
			topitoText: c.text,
			adText: best.p.text,
			similarity: Math.round(best.s * 100) / 100,
			via: c.via,
			impressions: best.p.impressions,
			ctr: best.p.ctr,
			score: best.p.score,
		});
	}
	writeJson(path.join(ROOT, "data", "topito-published.json"), { generatedAt: new Date().toISOString(), matches }, true);
	console.log(`Copys de Topito encontrados en anuncios: ${matches.length}`);
}

async function main() {
	const perfByBrand = {};
	let pending = false;
	for (const [brand, account] of Object.entries(ACCOUNTS)) {
		const dir = path.join(ROOT, "data", brand);
		const insightsPath = path.join(dir, ".ad-insights.json");
		const textsPath = path.join(dir, ".ad-texts.json");
		const cache = readJson(insightsPath, { quarters: {} });
		const texts = readJson(textsPath, {});
		let status = "done";
		try {
			status = await fetchInsights(brand, account, cache, () => writeJson(insightsPath, cache));
			if (status === "done") status = await fetchTexts(brand, account, cache, texts, () => writeJson(textsPath, texts));
		} catch (err) {
			if (!(err instanceof Throttled)) {
				writeJson(insightsPath, cache);
				writeJson(textsPath, texts);
				throw err;
			}
			console.log(`[${brand}] ${err.message}; se guarda y sigue en la próxima corrida.`);
			status = "throttled";
		}
		writeJson(insightsPath, cache);
		writeJson(textsPath, texts);
		if (status !== "done") pending = true;

		const items = buildPerformance(cache, texts);
		perfByBrand[brand] = items;
		writeJson(
			path.join(dir, "performance.json"),
			{
				generatedAt: new Date().toISOString(),
				metric: "CTR de link suavizado (70%) + costo por compra (30%) cuando hay ≥3 compras",
				complete: status === "done",
				items,
			},
		);
		const top = items.filter((t) => t.score >= 0.8).length;
		console.log(`[${brand}] performance.json: ${items.length} textos con score (${top} con score ≥ 0.8).`);
	}
	try {
		await findPublished(perfByBrand);
	} catch (err) {
		console.error("No se pudo buscar copys de Topito publicados:", err.message);
	}
	console.log(pending ? "Quedó pendiente al menos una marca; sigue en la próxima corrida." : "Listo. Desempeño al día.");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
