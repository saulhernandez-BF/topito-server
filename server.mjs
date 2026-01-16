import express from "express";
import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from "fs";

const app = express();
app.use(express.json());

// Middleware manual de CORS
app.use((req, res, next) => {
	res.header("Access-Control-Allow-Origin", "*"); // permite cualquier origen, incluido 'null'
	res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
	res.header("Access-Control-Allow-Headers", "Content-Type");
	if (req.method === "OPTIONS") {
		return res.sendStatus(200); // responde al preflight
	}
	next();
});

const genAI = new GoogleGenerativeAI("AIzaSyBvh6V0-NjBItDIGrCPMvFftfZ_CFIAVas");

const referenceData = JSON.parse(
	fs.readFileSync(new URL("./bNfWeb_clean.json", import.meta.url), "utf-8"),
);
const referenceText = referenceData.map((item) => item.text).join("\n\n");

app.post("/generate", async (req, res) => {
	try {
		const { prompt } = req.body;
		const model = genAI.getGenerativeModel({
			model: "models/gemini-2.5-flash",
		});
		console.log("Mandando el prompt");

		const fullPrompt = `
Eres un asistente que debe crear textos publicitarios (copy) respetando mi voz y tono.
Aquí tienes ejemplos de mi estilo extraídos de la web:

${referenceText}

Ahora, con base en ese estilo, responde a esta petición:
${prompt}
`;

		const result = await model.generateContent(fullPrompt);
		res.json({ text: result.response.text() });
	} catch (err) {
		console.error(err);
		res.status(500).json({ error: String(err) });
	}
});

app.listen(3000, () => {
	console.log("Server running on http://localhost:3000");
});
