async function runTest() {
	//const res = await fetch("https://topito-server.onrender.com/generate", {
	const res = await fetch("http://localhost:3000/test", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			prompt: "Revisa que opciones de lentes tenemos en tienda",
		}),
	});

	const data = await res.json();
	console.log("Respuesta del server:", data);
}

runTest();
