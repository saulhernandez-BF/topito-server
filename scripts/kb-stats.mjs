// Imprime el tamaño de la base de conocimiento por marca (ejemplos y embeddings).
// Lo usa el workflow para el resumen "antes / después" de cada corrida.
import fs from "fs";
for (const brand of ["benandfrank", "bombavista"]) {
	let examples = 0;
	let embeddings = 0;
	try {
		examples = JSON.parse(fs.readFileSync(`data/${brand}/tuning.json`, "utf-8")).length;
	} catch {}
	try {
		embeddings = JSON.parse(fs.readFileSync(`data/${brand}/tuning-embeddings.json`, "utf-8")).items.length;
	} catch {}
	let progress = "";
	try {
		const p = JSON.parse(fs.readFileSync(`data/${brand}/.meta-ads-progress.json`, "utf-8"));
		progress = ` (backfill en curso: ${p.adsCount} anuncios revisados)`;
	} catch {}
	console.log(`${brand}: ${examples} ejemplos, ${embeddings} embeddings${progress}`);
}
